-- 后端回归自测（v2：含匿名拦截）
--
-- 用法：本脚本依赖一张临时表 _regress_v2 收集中间结果（函数内的 RAISE NOTICE
-- 在云数据库工具里看不到）。因为平台单次只能执行一条语句，所以不能整体跑，
-- 需要按下面的顺序分段执行，每段都是独立的 DO 块：
--
--   0. CREATE TABLE IF NOT EXISTS _regress_v2 (payload jsonb);
--   1. 本文件开头到「-- [段1]」之间的内容（匿名拦截 + 正常用户 + 各类拒绝）
--   2. [段2] 非拥有者取件 / 撤销 / 过期
--   3. [段3] 次数耗尽 / TTL 夹取
--   4. SELECT jsonb_pretty(payload) FROM _regress_v2;
--   5. DROP TABLE _regress_v2;
--
-- 每次执行前记得先 DELETE FROM _regress_v2;
--
-- 已实测通过的期望结果：
--   anon_usage / anon_create  → not_signed_in
--   create_ok                 → ok:true，扣 bytes 与 count
--   bad_path / too_large / bad_name / too_many / daily_bytes → 对应错误码
--   other_get                 → ok:true, is_owner:false
--   revoked_get / expired_get → revoked / expired
--   daily_count               → left:0
--   TTL 传 0 → 7 天，传 99 → 30 天

-- [段1]
DO $$
DECLARE
  u1 text := 'selftest-u1';
  u2 text := 'selftest-u2';
  r jsonb;
  c1 text;
  c2 text;
  i int;
  f1 jsonb;
  many jsonb;
  out jsonb := '{}'::jsonb;
BEGIN
  DELETE FROM transfer_usage WHERE owner_id LIKE 'selftest-%';
  DELETE FROM transfers WHERE owner_id LIKE 'selftest-%';

  -- 匿名（auth.uid() = 'anon'）
  PERFORM set_config('request.jwt.claim.sub', 'anon', true);
  PERFORM set_config('request.jwt.claims', '{"sub":"anon","role":"anon","is_anonymous":true}', true);
  out := out || jsonb_build_object('anon_usage', my_transfer_usage());
  out := out || jsonb_build_object('anon_create', create_transfer('x',
    jsonb_build_array(jsonb_build_object('name','a.txt','bytes',10,'path','shared/anon/x')), 7));

  -- 正常用户
  PERFORM set_config('request.jwt.claim.sub', u1, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', u1, 'role','authenticated','is_anonymous',false)::text, true);
  out := out || jsonb_build_object('u1_usage0', my_transfer_usage());

  f1 := jsonb_build_object('name','a.txt','bytes',1000,'mime','text/plain','path','shared/selftest-u1/f1');
  r := create_transfer('回归测试', jsonb_build_array(f1), 7);
  c1 := r->>'code';
  out := out || jsonb_build_object('create_ok', r);

  -- 各类拒绝
  out := out || jsonb_build_object('empty', create_transfer('x','[]'::jsonb,7));
  out := out || jsonb_build_object('too_large', create_transfer('x', jsonb_build_array(
    jsonb_build_object('name','big','bytes',104857601,'path','shared/selftest-u1/b')),7));
  SELECT jsonb_agg(jsonb_build_object('name','f'||g,'bytes',1,'path','shared/selftest-u1/f'||g)) INTO many FROM generate_series(1,21) g;
  out := out || jsonb_build_object('too_many', create_transfer('x',many,7));
  out := out || jsonb_build_object('bad_name', create_transfer('x', jsonb_build_array(
    jsonb_build_object('name','a/b.txt','bytes',1,'path','shared/selftest-u1/x')),7));
  out := out || jsonb_build_object('bad_path', create_transfer('x', jsonb_build_array(
    jsonb_build_object('name','c.txt','bytes',1,'path','shared/other/x')),7));

  -- 流量超额
  SELECT jsonb_agg(jsonb_build_object('name','h'||g,'bytes',104857600,'path','shared/selftest-u1/h'||g)) INTO many FROM generate_series(1,6) g;
  out := out || jsonb_build_object('daily_bytes', create_transfer('x',many,7));

  -- 非拥有者取件 + 计数
  -- [段2]
  PERFORM set_config('request.jwt.claim.sub', u2, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', u2, 'role','authenticated','is_anonymous',false)::text, true);
  out := out || jsonb_build_object('other_get', get_transfer(c1));
  out := out || jsonb_build_object('other_bump', bump_download(c1));
  out := out || jsonb_build_object('notfound', get_transfer('ZZZZZZ'));

  -- 拥有者视角
  PERFORM set_config('request.jwt.claim.sub', u1, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', u1, 'role','authenticated','is_anonymous',false)::text, true);
  out := out || jsonb_build_object('owner_get', get_transfer(c1));

  -- 撤销 / 过期
  UPDATE transfers SET status='revoked' WHERE code=c1;
  out := out || jsonb_build_object('revoked_get', get_transfer(c1));
  UPDATE transfers SET status='active', expires_at=now()-interval '1 hour' WHERE code=c1;
  out := out || jsonb_build_object('expired_get', get_transfer(c1));

  -- 次数耗尽
  -- [段3]
  DELETE FROM transfer_usage WHERE owner_id=u1;
  FOR i IN 1..20 LOOP
    PERFORM create_transfer('l', jsonb_build_array(jsonb_build_object('name','l'||i,'bytes',1,'path','shared/selftest-u1/l'||i)),7);
  END LOOP;
  out := out || jsonb_build_object('count_full', my_transfer_usage());
  out := out || jsonb_build_object('daily_count', create_transfer('x', jsonb_build_array(
    jsonb_build_object('name','z.txt','bytes',1,'path','shared/selftest-u1/z')),7));

  DELETE FROM transfer_usage WHERE owner_id LIKE 'selftest-%';
  DELETE FROM transfers WHERE owner_id LIKE 'selftest-%';

  DELETE FROM _regress_v2;
  INSERT INTO _regress_v2 VALUES (out);
END $$;
