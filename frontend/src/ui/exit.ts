import { AnimationEvent, useEffect, useRef, useState } from "react";

/**
 * Keeps a closing element on screen while its exit animation plays (one step faster than its entry),
 * then removes it. Without an animation (or with reduced motion) it goes at once.
 */
export function useExit<T extends HTMLElement>(open: boolean) {
  const [shown, setShown] = useState(open);
  const [closing, setClosing] = useState(false);
  const ref = useRef<T>(null);

  if (open && (!shown || closing)) {
    // Opening again: show at once, during render, so nothing flickers.
    setShown(true);
    setClosing(false);
  } else if (!open && shown && !closing) {
    setClosing(true);
  }

  useEffect(() => {
    if (!closing) return;
    const element = ref.current;
    if (!element || getComputedStyle(element).animationName === "none") {
      setShown(false);
      setClosing(false);
    }
  }, [closing]);

  const onAnimationEnd = (event: AnimationEvent<T>) => {
    if (closing && event.target === event.currentTarget) {
      setShown(false);
      setClosing(false);
    }
  };

  return { shown, closing, ref, onAnimationEnd };
}
