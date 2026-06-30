(() => {
  let pendingFrame = null;

  function fitName(name) {
    if (!(name instanceof HTMLElement) || !name.isConnected || name.clientWidth <= 0) return;
    name.style.removeProperty('font-size');
    const maximum = Number.parseFloat(getComputedStyle(name).fontSize) || 19;
    if (name.scrollWidth <= name.clientWidth) return;

    let lower = 6;
    let upper = maximum;
    while (upper - lower > 0.25) {
      const candidate = (lower + upper) / 2;
      name.style.fontSize = `${candidate}px`;
      if (name.scrollWidth <= name.clientWidth) lower = candidate;
      else upper = candidate;
    }
    name.style.fontSize = `${lower}px`;
  }

  function fitAllCardNames(root = document) {
    root.querySelectorAll('.player-card-name').forEach(fitName);
  }

  function scheduleFit() {
    if (pendingFrame != null) cancelAnimationFrame(pendingFrame);
    pendingFrame = requestAnimationFrame(() => {
      pendingFrame = null;
      fitAllCardNames();
    });
  }

  function start() {
    fitAllCardNames();
    const observer = new MutationObserver(scheduleFit);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class', 'hidden']
    });
    window.addEventListener('resize', scheduleFit);
    document.fonts?.ready.then(scheduleFit);
  }

  window.fitWutCardNames = fitAllCardNames;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
