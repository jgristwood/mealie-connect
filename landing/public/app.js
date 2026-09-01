(() => {
  const NS = 'http://www.w3.org/2000/svg';
  const icons = {
    download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
    external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    github: '<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3.3-.4 6.8-1.6 6.8-7A5.4 5.4 0 0 0 19.3 4 5 5 0 0 0 19.2.5S18 0 15 2a13.4 13.4 0 0 0-7 0C5 .1 3.8.5 3.8.5A5 5 0 0 0 3.7 4a5.4 5.4 0 0 0-1.5 3.7c0 5.4 3.5 6.6 6.8 7A4.8 4.8 0 0 0 8 18v4"/><path d="M8 19c-3 .9-3-1.5-4-2"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    calendar: '<rect width="18" height="18" x="3" y="4" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    cart: '<circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h7.8a2 2 0 0 0 2-1.58L20.05 7H5.12"/>',
    utensils: '<path d="M3 2v7c0 1.1.9 2 2 2h2c1.1 0 2-.9 2-2V2M7 2v20M21 15V2c-3 0-5 2-5 5v5c0 1.1.9 2 2 2h3Zm0 0v7"/>',
    dice: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M8 8h.01M16 16h.01M16 8h.01M8 16h.01M12 12h.01"/>',
    check: '<path d="m20 6-11 11-5-5"/>',
    folder: '<path d="M3 7h5l2 3h11v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M3 7V5a2 2 0 0 1 2-2h3l2 3h9a2 2 0 0 1 2 2v2"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    tag: '<path d="M12.6 2.8A2 2 0 0 0 11.2 2H4a2 2 0 0 0-2 2v7.2a2 2 0 0 0 .6 1.4l8.8 8.8a2 2 0 0 0 2.8 0l7.2-7.2a2 2 0 0 0 0-2.8Z"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1"/><path d="M14 11a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 12 20l1.1-1.1"/>',
    'wifi-off': '<path d="m2 8.8 2 2M5 5.5A15.7 15.7 0 0 1 22 8.8M8.5 8.5a10.4 10.4 0 0 1 10.5 2.3M12 20h.01M2 2l20 20M8.5 15.5a5 5 0 0 1 7 0"/>',
    server: '<rect width="20" height="8" x="2" y="2" rx="2"/><rect width="20" height="8" x="2" y="14" rx="2"/><path d="M6 6h.01M6 18h.01"/>',
    shield: '<path d="M20 13c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V5l8-3 8 3Z"/><path d="m9 12 2 2 4-4"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
    'cloud-off': '<path d="M17.5 19H9a7 7 0 0 1-6.7-9M5.3 5.3A7 7 0 0 1 17 7h1a4 4 0 0 1 3.9 4.9M2 2l20 20"/>',
    smartphone: '<rect width="14" height="20" x="5" y="2" rx="2"/><path d="M12 18h.01"/>',
    android: '<path d="M8 5 6.5 2.5M16 5l1.5-2.5M5 10h14v8H5zM7 7h.01M17 7h.01M7 18v3M17 18v3M3 10v6M21 10v6"/>',
    monitor: '<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8M12 17v4"/>'
  };

  document.querySelectorAll('[data-icon]').forEach((placeholder) => {
    const name = placeholder.dataset.icon;
    const size = placeholder.dataset.size || '18';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = icons[name] || '';
    placeholder.replaceWith(svg);
  });

  const header = document.getElementById('site-header');
  const menuButton = document.getElementById('menu-button');
  const mobileMenu = document.getElementById('mobile-menu');
  let menuOpen = false;

  const setMenu = (open) => {
    menuOpen = open;
    mobileMenu.hidden = !open;
    menuButton.setAttribute('aria-expanded', String(open));
    menuButton.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    menuButton.innerHTML = '';
    const span = document.createElement('span');
    span.dataset.icon = open ? 'x' : 'menu';
    span.dataset.size = '22';
    menuButton.appendChild(span);
    const name = span.dataset.icon;
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', '22'); svg.setAttribute('height', '22'); svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round'); svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = icons[name]; span.replaceWith(svg);
    document.body.style.overflow = open ? 'hidden' : '';
  };

  menuButton.addEventListener('click', () => setMenu(!menuOpen));
  document.querySelectorAll('.mobile-link').forEach((a) => a.addEventListener('click', () => setMenu(false)));

  const updateHeader = () => {
    const scrolled = window.scrollY > 8;
    header.classList.toggle('bg-charcoal-950/85', scrolled);
    header.classList.toggle('backdrop-blur-md', scrolled);
    header.classList.toggle('border-b', scrolled);
    header.classList.toggle('border-cream-50/10', scrolled);
    header.classList.toggle('bg-transparent', !scrolled);
  };
  updateHeader();
  window.addEventListener('scroll', updateHeader, { passive: true });

  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add('reveal-visible');
          observer.unobserve(entry.target);
        }
      }
    }, { threshold: 0.15 });
    document.querySelectorAll('.reveal').forEach((el) => observer.observe(el));
  } else {
    document.querySelectorAll('.reveal').forEach((el) => el.classList.add('reveal-visible'));
  }
})();
