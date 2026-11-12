// Theme switcher: swaps the CSS variables the pages already use, plus a few structural rules per theme.
(function () {
  var THEMES = [
    { id: 'ledger', name: 'Ledger', sw: ['#f6f5f1', '#1f5f4a'] },
    { id: 'highway', name: 'Highway', sw: ['#0c3b26', '#ffd100'] },
    { id: 'terminal', name: 'Terminal', sw: ['#0a0c08', '#ffb000'] },
    { id: 'blueprint', name: 'Blueprint', sw: ['#0d2a4a', '#5cd6ff'] },
    { id: 'paper', name: 'Paper', sw: ['#f3eddf', '#9c1c1c'] },
  ];
  var KEY = 'dotty-theme';
  var css = [
    '.themes{display:flex;gap:10px;justify-content:flex-end;align-items:center;margin:0 0 14px}',
    '.themes span{font-size:12px;color:var(--muted);margin-right:2px}',
    '.themes button{width:26px;height:26px;padding:0;border-radius:50%;border:2px solid var(--line);cursor:pointer}',
    '.themes button[aria-pressed=true]{outline:2px solid var(--ink);outline-offset:2px}',
    '.themes button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}',

    /* Highway: green guide sign, white border, reflective yellow */
    ':root[data-theme=highway]{color-scheme:dark;--bg:#0c3b26;--card:#0f4a30;--ink:#fff;--muted:#b6d6c4;--line:#3a7a58;--accent:#ffd100;',
    '--high:#ffb4a8;--high-bg:#5a2018;--med:#ffd666;--med-bg:#4d3a0a;--low:#d3e8dc;--low-bg:#1b5a3c;--ok:#a6f2c6;--ok-bg:#0f6a3e}',
    '[data-theme=highway] h1{text-transform:uppercase;letter-spacing:.06em;font-weight:800;font-size:30px}',
    '[data-theme=highway] .card{border:2px solid rgba(255,255,255,.85);border-radius:14px}',
    '[data-theme=highway] input,[data-theme=highway] select{border:2px solid rgba(255,255,255,.6)}',
    '[data-theme=highway] button.primary{color:#0c3b26;text-transform:uppercase;letter-spacing:.05em;font-weight:800}',
    '[data-theme=highway] .card h4,[data-theme=highway] .sev{letter-spacing:.1em}',

    /* Terminal: amber phosphor, monospace, square corners */
    ':root[data-theme=terminal]{color-scheme:dark;--bg:#0a0c08;--card:#0f130b;--ink:#ffb000;--muted:#b07d00;--line:#3d2c00;--accent:#ffcc33;',
    '--high:#ff6b57;--high-bg:#2b0f0b;--med:#ffcc33;--med-bg:#2a2000;--low:#c99a2e;--low-bg:#1c1600;--ok:#8fe36a;--ok-bg:#112008}',
    '[data-theme=terminal] body,[data-theme=terminal] input,[data-theme=terminal] select,[data-theme=terminal] button{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}',
    '[data-theme=terminal] h1::before{content:"> ";color:var(--accent)}',
    '[data-theme=terminal] h1::after{content:"_";color:var(--accent);animation:blink 1.1s steps(1) infinite}',
    '@keyframes blink{50%{opacity:0}}@media (prefers-reduced-motion:reduce){[data-theme=terminal] h1::after{animation:none}}',
    '[data-theme=terminal] .card,[data-theme=terminal] input,[data-theme=terminal] select,[data-theme=terminal] button,[data-theme=terminal] .level,[data-theme=terminal] .chip,[data-theme=terminal] .sev{border-radius:2px}',
    '[data-theme=terminal] button.primary{color:#0a0c08}',

    /* Blueprint: drafting grid, mono headings, cyan lines */
    ':root[data-theme=blueprint]{color-scheme:dark;--bg:#0d2a4a;--card:rgba(10,36,64,.78);--ink:#e6f1ff;--muted:#8fb3d9;--line:#2f5c93;--accent:#5cd6ff;',
    '--high:#ffb0a0;--high-bg:#4a1d28;--med:#ffd98a;--med-bg:#3d3210;--low:#b9d4f2;--low-bg:#163a63;--ok:#8fe8c4;--ok-bg:#0f4a4a}',
    '[data-theme=blueprint] body{background-image:linear-gradient(rgba(92,214,255,.07) 1px,transparent 1px),linear-gradient(90deg,rgba(92,214,255,.07) 1px,transparent 1px);background-size:24px 24px}',
    '[data-theme=blueprint] h1,[data-theme=blueprint] h2,[data-theme=blueprint] h3,[data-theme=blueprint] h4,[data-theme=blueprint] dt{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}',
    '[data-theme=blueprint] .card,[data-theme=blueprint] input,[data-theme=blueprint] select,[data-theme=blueprint] button,[data-theme=blueprint] .level{border-radius:3px}',
    '[data-theme=blueprint] .card{border-style:dashed}',
    '[data-theme=blueprint] button.primary{color:#0d2a4a}',

    /* Paper: newsprint, serif, hairline rules, ink-red accent */
    ':root[data-theme=paper]{color-scheme:light;--bg:#f3eddf;--card:#fbf7ec;--ink:#1a1612;--muted:#6b6253;--line:#cfc4ab;--accent:#9c1c1c;',
    '--high:#9c1c1c;--high-bg:#f4dcd4;--med:#7a4f00;--med-bg:#f3e6c3;--low:#4a4438;--low-bg:#e9e1cd;--ok:#2d5a35;--ok-bg:#dce7d2}',
    '[data-theme=paper] body{font-family:Charter,"Iowan Old Style",Georgia,"Times New Roman",serif}',
    '[data-theme=paper] input,[data-theme=paper] select,[data-theme=paper] button{font-family:inherit}',
    '[data-theme=paper] h1{font-size:44px;font-weight:700;letter-spacing:-.03em;border-bottom:3px double var(--ink);padding-bottom:8px}',
    '[data-theme=paper] .card{border-radius:0;border:1px solid var(--line);border-top:3px solid var(--ink)}',
    '[data-theme=paper] input,[data-theme=paper] select,[data-theme=paper] button,[data-theme=paper] .level{border-radius:0}',
    '[data-theme=paper] .chip,[data-theme=paper] .sev{border-radius:0}',
    '[data-theme=paper] button.primary{color:#fbf7ec}',
  ].join('\n');

  function get() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function set(id) { try { localStorage.setItem(KEY, id); } catch (e) {} }
  function apply(id) {
    var ok = THEMES.some(function (t) { return t.id === id; });
    if (!ok || id === 'ledger') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', id);
    var cur = document.documentElement.getAttribute('data-theme') || 'ledger';
    var btns = document.querySelectorAll('.themes button');
    for (var i = 0; i < btns.length; i++) btns[i].setAttribute('aria-pressed', String(btns[i].dataset.id === cur));
  }

  var style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
  apply(get());

  document.addEventListener('DOMContentLoaded', function () {
    var main = document.querySelector('main');
    if (!main) return;
    var bar = document.createElement('div');
    bar.className = 'themes';
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', 'Theme');
    var label = document.createElement('span');
    label.textContent = 'Theme';
    bar.appendChild(label);
    THEMES.forEach(function (t) {
      var b = document.createElement('button');
      b.type = 'button';
      b.dataset.id = t.id;
      b.title = t.name;
      b.setAttribute('aria-label', t.name + ' theme');
      b.style.background = 'linear-gradient(135deg,' + t.sw[0] + ' 50%,' + t.sw[1] + ' 50%)';
      b.addEventListener('click', function () { set(t.id); apply(t.id); });
      bar.appendChild(b);
    });
    main.insertBefore(bar, main.firstChild);
    apply(get());
  });
})();
