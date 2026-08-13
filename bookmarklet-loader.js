(() => {
  const BASE = 'https://cubesky.github.io/NoriOS-Voice/norios-voice.user.js';
  const ID = '__norios_voice_bookmarklet_loader__';

  document.getElementById(ID)?.remove();

  const script = document.createElement('script');
  script.id = ID;
  script.src = BASE + '?bookmarklet=' + Date.now();
  script.async = true;

  script.onload = () => {
    console.log('[NoriOS Voice] external userscript loaded');
    script.remove();
  };

  script.onerror = () => {
    console.error(
      '[NoriOS Voice] failed to load:',
      script.src,
      'The page CSP may block external scripts. Install norios-voice.user.js as a userscript if needed.'
    );
    script.remove();
  };

  (document.head || document.documentElement).appendChild(script);
})();