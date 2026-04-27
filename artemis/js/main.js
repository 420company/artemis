/* ============================================================
   ARTEMIS — Interactive Layer
   ============================================================ */

(function () {
  'use strict';

  /* ---- Canvas Background ---- */
  const canvas = document.getElementById('bg-canvas');
  if (canvas) {
    const ctx = canvas.getContext('2d');
    let w, h, particles = [];

    function resize() {
      w = canvas.width = window.innerWidth;
      h = canvas.height = window.innerHeight;
    }

    class Particle {
      constructor() {
        this.reset();
        this.y = Math.random() * h;
      }
      reset() {
        this.x = Math.random() * w;
        this.y = 0;
        this.size = Math.random() * 1.2 + 0.3;
        this.speed = Math.random() * 0.4 + 0.1;
        this.opacity = Math.random() * 0.5 + 0.15;
        this.wobble = Math.random() * Math.PI * 2;
        this.wobbleSpeed = (Math.random() - 0.5) * 0.02;
        this.color = Math.random() > 0.5 ? '99,217,255' : '255,122,168';
      }
      update() {
        this.y -= this.speed;
        this.wobble += this.wobbleSpeed;
        this.x += Math.sin(this.wobble) * 0.3;
        if (this.y < -10) { this.y = h + 10; this.x = Math.random() * w; }
        if (this.x < -10) this.x = w + 10;
        if (this.x > w + 10) this.x = -10;
      }
      draw(ctx) {
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${this.color},${this.opacity})`;
        ctx.fill();
      }
    }

    const count = Math.min(Math.floor((w * h) / 18000), 140);
    for (let i = 0; i < count; i++) {
      particles.push(new Particle());
    }

    function drawGrid() {
      const s = 50;
      ctx.strokeStyle = 'rgba(99,217,255,0.025)';
      ctx.lineWidth = 0.5;
      for (let x = s; x < w; x += s) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      }
      for (let y = s; y < h; y += s) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      }
    }

    function animate() {
      ctx.clearRect(0, 0, w, h);
      drawGrid();
      particles.forEach(p => { p.update(); p.draw(ctx); });
      requestAnimationFrame(animate);
    }

    resize();
    animate();
    window.addEventListener('resize', () => {
      resize();
      particles = [];
      const newCount = Math.min(Math.floor((w * h) / 18000), 140);
      for (let i = 0; i < newCount; i++) particles.push(new Particle());
    });
  }

  /* ---- Copy Buttons ---- */
  document.querySelectorAll('.copy-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const codeEl = btn.closest('.code-block')?.querySelector('pre code');
      if (!codeEl) return;
      const text = codeEl.textContent;
      navigator.clipboard.writeText(text).then(() => {
        btn.textContent = 'copied';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = 'copy';
          btn.classList.remove('copied');
        }, 1600);
      }).catch(() => {
        btn.textContent = 'failed';
        setTimeout(() => { btn.textContent = 'copy'; }, 1200);
      });
    });
  });

  /* ---- Sponsor Modal ---- */
  const modal = document.getElementById('sponsor-modal');
  const openBtn = document.querySelector('.btn-sponsor');
  const closeBtn = document.getElementById('modal-close');

  if (openBtn && modal) {
    openBtn.addEventListener('click', () => {
      modal.classList.add('active');
    });
  }
  if (closeBtn && modal) {
    closeBtn.addEventListener('click', () => {
      modal.classList.remove('active');
    });
  }
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.classList.remove('active');
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') modal.classList.remove('active');
    });
  }

  /* ---- Toast ---- */
  window.showToast = function (msg) {
    let toast = document.querySelector('.toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'toast';
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toast._timeout);
    toast._timeout = setTimeout(() => toast.classList.remove('show'), 2200);
  };

})();
