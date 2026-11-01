// Instalação do painel como aplicativo (Android/Chrome/Edge: botão nativo; iPhone: instruções).
(function () {
  'use strict';
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/admin/sw.js', { scope: '/admin/' }).catch(() => {}));
  }
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (standalone) return;
  let KEY = 'pwa-dispensado';
  try { if (localStorage.getItem(KEY)) return; } catch { /* */ }
  let deferred = null;

  function banner(texto, botao) {
    if (document.getElementById('pwa-banner')) return;
    const bar = document.createElement('div');
    bar.id = 'pwa-banner'; bar.className = 'pwa-banner'; bar.setAttribute('role', 'dialog');
    const p = document.createElement('span'); p.textContent = texto; bar.appendChild(p);
    if (botao) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'btn sm'; b.textContent = botao;
      b.addEventListener('click', async () => {
        if (!deferred) return;
        deferred.prompt(); try { await deferred.userChoice; } catch { /* */ }
        deferred = null; bar.remove();
      });
      bar.appendChild(b);
    }
    const x = document.createElement('button'); x.type = 'button'; x.className = 'btn sm secondary'; x.textContent = 'Agora não';
    x.addEventListener('click', () => { bar.remove(); try { localStorage.setItem(KEY, '1'); } catch { /* */ } });
    bar.appendChild(x);
    document.body.appendChild(bar);
  }

  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; banner('Instale o painel no seu celular para abrir como aplicativo.', 'Instalar'); });
  window.addEventListener('appinstalled', () => { document.getElementById('pwa-banner')?.remove(); });
  // iPhone/iPad (Safari) não tem o evento: mostra o caminho manual.
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
  if (ios) window.addEventListener('load', () => setTimeout(() => banner('Para instalar: toque em Compartilhar e depois em "Adicionar à Tela de Início".'), 2500));
})();
