(function () {
  'use strict';

  const form = document.getElementById('loginForm');
  const pin = document.getElementById('pin');
  const msg = document.getElementById('msg');
  const btn = document.getElementById('btnLogin');
  const tip = document.getElementById('tip');

  let lockTimer = null;

  function setMsg(text, ok) {
    msg.textContent = text || '';
    msg.className = 'login-msg' + (ok ? ' ok' : '');
  }

  function setLock(seconds) {
    if (!seconds || seconds <= 0) {
      btn.disabled = false;
      btn.textContent = '进入';
      clearInterval(lockTimer);
      return;
    }
    let left = seconds;
    btn.disabled = true;
    pin.disabled = true;
    btn.textContent = '锁定 ' + left + ' 秒';
    setMsg('尝试次数过多，请稍候');
    clearInterval(lockTimer);
    lockTimer = setInterval(() => {
      left -= 1;
      if (left <= 0) {
        clearInterval(lockTimer);
        btn.disabled = false;
        pin.disabled = false;
        btn.textContent = '进入';
        setMsg('');
        pin.focus();
      } else {
        btn.textContent = '锁定 ' + left + ' 秒';
      }
    }, 1000);
  }

  async function checkStatus() {
    try {
      const res = await fetch('/api/auth-status', { cache: 'no-store' });
      const data = await res.json();
      if (data.authed) {
        location.replace('/');
        return;
      }
      if (data.readOnly) {
        tip.textContent = '当前服务器为只读模式：登录后只能浏览和下载。';
      }
      if (data.lockedFor > 0) setLock(data.lockedFor);
    } catch (_) {
      /* 忽略 */
    }
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const value = pin.value.trim();
    if (!value) return setMsg('请输入 PIN 码');

    btn.disabled = true;
    btn.textContent = '验证中…';
    setMsg('');

    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: value }),
      });
      const data = await res.json().catch(() => ({}));

      if (res.ok) {
        setMsg('验证通过，正在进入…', true);
        location.replace('/');
        return;
      }

      setMsg(data.error || 'PIN 码不正确');
      pin.value = '';
      pin.focus();
      btn.disabled = false;
      btn.textContent = '进入';
      if (res.status === 429 && data.retryAfter) setLock(data.retryAfter);
    } catch (err) {
      setMsg('网络错误，请重试');
      btn.disabled = false;
      btn.textContent = '进入';
    }
  });

  pin.focus();
  checkStatus();
})();