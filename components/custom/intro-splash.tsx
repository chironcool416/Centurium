/* Intro splash coin: the laurel wreath (branches) stays perfectly flat and
   still; the base ring+helmet emblem — the "coin" — spins in place in true
   3D on its vertical axis, counterclockwise, for the full ~10s hold (looped
   indefinitely since the hold duration varies with prefers-reduced-motion).
   Built as a two-sided flip card (front + back faces, each the same logo,
   each hidden via backface-visibility while facing away) rather than a flat
   2D rotation, so as the coin turns edge-on and keeps going, the same logo
   reappears on "the other side" instead of just spinning flat in the
   picture plane. Linear timing (not eased) so the spin reads as one
   constant, un-stuttering rotation. */
.intro-emblem-coin-scene {
  position: absolute;
  inset: 0;
  perspective: 1600px;
}
.intro-emblem-coin {
  position: relative;
  width: 100%;
  height: 100%;
  transform-style: preserve-3d;
  transform-origin: 50% 50%;
  animation: intro-emblem-spin-3d 3s linear infinite;
}
.intro-emblem-coin-face {
  backface-visibility: hidden;
}
.intro-emblem-coin-face-back {
  /* Pre-mirrored so that once the coin has turned enough to show this face
     to the viewer, the logo reads right-way-round instead of as a mirror
     image of the front. */
  transform: rotateY(180deg) scaleX(-1);
}
@keyframes intro-emblem-spin-3d {
  from {
    transform: rotateY(0deg);
  }
  to {
    transform: rotateY(-360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .intro-emblem-coin {
    animation: none;
  }
}
.intro-emblem-wreath {
  object-fit: contain;
}
