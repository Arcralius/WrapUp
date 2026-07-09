const errorEl = document.getElementById('authError');

function showError(message) {
  errorEl.textContent = message;
  errorEl.classList.add('visible');
}

function clearError() {
  errorEl.textContent = '';
  errorEl.classList.remove('visible');
}

const loginForm = document.getElementById('loginForm');
if (loginForm) {
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError();
    const submitBtn = document.getElementById('submitBtn');
    submitBtn.disabled = true;

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: document.getElementById('username').value.trim(),
          password: document.getElementById('password').value,
        }),
      });
      const result = await res.json();
      if (!res.ok || !result.ok) {
        showError(result.error || 'Login failed.');
        return;
      }
      window.location.href = 'index.html';
    } catch {
      showError('Something went wrong — check your connection and try again.');
    } finally {
      submitBtn.disabled = false;
    }
  });
}

const signupForm = document.getElementById('signupForm');
if (signupForm) {
  signupForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError();

    const password = document.getElementById('password').value;
    const confirmPassword = document.getElementById('confirmPassword').value;
    if (password !== confirmPassword) {
      showError('Passwords do not match.');
      return;
    }

    const submitBtn = document.getElementById('submitBtn');
    submitBtn.disabled = true;

    try {
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: document.getElementById('username').value.trim(),
          email: document.getElementById('email').value.trim(),
          password,
        }),
      });
      const result = await res.json();
      if (!res.ok || !result.ok) {
        showError(result.error || 'Sign up failed.');
        return;
      }
      window.location.href = 'index.html';
    } catch {
      showError('Something went wrong — check your connection and try again.');
    } finally {
      submitBtn.disabled = false;
    }
  });
}
