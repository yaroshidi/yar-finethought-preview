/* The homepage reel: one video element plays the project promos in turn, with the
   client's name, year and line under it. It plays while it is on screen and holds
   when the visitor pauses it. Reduced motion starts it held. */
(() => {
  const box = document.getElementById("minireel");
  if (!box) return;
  const video = box.querySelector(".minireel__video");
  const name = box.querySelector(".minireel__name");
  const year = box.querySelector(".minireel__year");
  const line = box.querySelector(".minireel__line");
  const pause = box.querySelector(".minireel__pause");
  const clips = JSON.parse(box.dataset.clips);
  const still = window.matchMedia("(prefers-reduced-motion: reduce)");
  let index = 0;
  let held = still.matches;
  let onScreen = false;

  pause.removeAttribute("aria-pressed");

  const label = () => {
    pause.classList.toggle("is-paused", held);
    pause.setAttribute("aria-label", held ? "Play the projects" : "Pause the projects");
  };
  const play = () => {
    if (!held && onScreen) video.play().catch(() => {});
  };
  const cue = (n) => {
    index = (n + clips.length) % clips.length;
    const c = clips[index];
    video.poster = c.poster;
    video.src = c.src;
    name.textContent = c.name;
    name.href = c.href;
    year.textContent = c.year;
    line.textContent = c.line;
    play();
  };

  video.addEventListener("ended", () => cue(index + 1));
  pause.addEventListener("click", () => {
    held = !held;
    if (held) video.pause();
    else play();
    label();
  });
  new IntersectionObserver(([entry]) => {
    onScreen = entry.isIntersecting;
    if (onScreen) play();
    else video.pause();
  }, { threshold: 0.4 }).observe(video);

  /* ONE VIDEO, EXPANDED (2026-10-19, Yar): the frame is a button. Pressed, the
     same figure expands over the page with GSAP Flip — one element morphed, no
     second player — and plays on. Escape, the close key or a press on the veil
     sends it back. Without GSAP or under reduced motion the class still lands,
     only without the animation. */
  const openBtn = box.querySelector(".minireel__open");
  const closeBtn = box.querySelector(".minireel__close");
  const veil = document.querySelector(".reelveil");
  if (openBtn && closeBtn && veil) {
    const expanded = () => box.classList.contains("is-expanded");
    // the expanded size is set inline in the same synchronous block Flip reads
    // and animates from, so the morph is one straight run between two real
    // layouts; the CSS only centres the box (inset:0, margin:auto).
    const size = () => {
      const vw = innerWidth, vh = innerHeight;
      // on a phone the frame runs to the screen's edges: a 16:9 cut can only
      // grow so far in portrait, and the inset margins left it smaller than
      // the reel it came from
      const cap = Math.min(vh * 16 / 9 - 200, 1180, vw - (vw <= 720 ? 0 : 64));
      box.style.width = Math.max(280, cap) + "px";
      // the caption travels with the frame, so the figure centres on its
      // whole height instead of hanging the caption under the fold.
      // bottom:auto or the fixed box stretches to the viewport and its
      // "auto" height measures the screen, not the figure.
      box.style.height = "auto";
      box.style.bottom = "auto";
      box.style.height = box.offsetHeight + "px";
      box.style.bottom = "";
    };
    const clear = () => { box.style.width = ""; box.style.height = ""; };
    const setState = (open) => {
      const move = () => {
        box.classList.toggle("is-expanded", open);
        if (open) size(); else clear();
        veil.hidden = !open;
        document.body.classList.toggle("reelopen", open);
        if (open) closeBtn.focus({ preventScroll: true });
        else openBtn.focus({ preventScroll: true });
        play();
      };
      if (window.gsap && window.Flip && !(still.matches)) {
        const state = window.Flip.getState(box);
        // no CSS transition while GSAP drives the box, or each frame eases again
        box.classList.add("is-morphing");
        move();
        // absolute: the figure leaves the hero's flow for the length of the
        // morph. Without it the closing tween shrinks its width and height
        // in place, so the hero's grid tracked every frame and the copy
        // around the reel visibly reflowed while the video came back
        // (Yar, 2026-10-20). Out of flow, the page settles once and the one
        // element does the travelling.
        window.Flip.from(state, { duration: 0.56, ease: "power3.inOut", scale: false, prune: true,
          absolute: !open,
          onComplete: () => {
            /* Closing leaves a transform on the box (Flip's absolute stage
               offsets it from its in-flow position, then hands the layout
               back). That clear has to happen while .is-morphing still turns
               transitions off: the hero entrance rule on .minireel
               (opacity/transform .40s with a 160ms delay) otherwise animates
               the reset, so the reel finished at its correct size but 720px
               off-screen and then slid home over 400ms. Yar saw that as the
               figure "dismorphing" and flying out before it settled. */
            window.gsap.set(box, { clearProps: "transform" });
            requestAnimationFrame(() => {
              box.classList.remove("is-morphing");
              if (!expanded()) clear();
            });
          } });
      } else {
        move();
      }
    };
    openBtn.addEventListener("click", () => { if (!expanded()) setState(true); });
    closeBtn.addEventListener("click", () => { if (expanded()) setState(false); });
    veil.addEventListener("click", () => { if (expanded()) setState(false); });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && expanded()) { e.preventDefault(); setState(false); }
    });
    addEventListener("resize", () => { if (expanded()) size(); });
  }

  cue(0);
  label();
})();
