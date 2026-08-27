/* Custom CSS for this template */
/* Add your custom styles here */

/* No-code build mode: briefly flash the draggable blocks (3× over 1.5s) when the
   layout is unlocked, so it's clear the components can be dragged to reorder. */
@keyframes nocode-drag-hint {
  0%,
  100% {
    box-shadow: 0 0 0 0 rgb(var(--primary) / 0);
    border-color: rgb(var(--border));
  }
  50% {
    box-shadow: 0 0 0 3px rgb(var(--primary) / 0.35);
    border-color: rgb(var(--primary));
  }
}
.nocode-drag-hint {
  animation: nocode-drag-hint 1s ease-in-out 2;
}
@media (prefers-reduced-motion: reduce) {
  .nocode-drag-hint {
    animation: none;
  }
}

/* Soft, slowly-breathing glow around a panel — outlines it in the theme's
   primary color with a layered box-shadow (tight edge + wide bloom). */
@keyframes panel-glow-pulse {
  0%,
  100% {
    border-color: rgb(var(--primary) / 0.5);
    box-shadow:
      0 0 0 1px rgb(var(--primary) / 0.25),
      0 0 20px 2px rgb(var(--primary) / 0.35),
      0 0 48px 10px rgb(var(--primary) / 0.16);
  }
  50% {
    border-color: rgb(var(--primary) / 0.75);
    box-shadow:
      0 0 0 1px rgb(var(--primary) / 0.4),
      0 0 26px 4px rgb(var(--primary) / 0.5),
      0 0 60px 14px rgb(var(--primary) / 0.22);
  }
}
.panel-glow {
  border-color: rgb(var(--primary) / 0.5);
  box-shadow:
    0 0 0 1px rgb(var(--primary) / 0.25),
    0 0 20px 2px rgb(var(--primary) / 0.35),
    0 0 48px 10px rgb(var(--primary) / 0.16);
  animation: panel-glow-pulse 3s ease-in-out infinite;
}
@media (prefers-reduced-motion: reduce) {
  .panel-glow {
    animation: none;
  }
}
