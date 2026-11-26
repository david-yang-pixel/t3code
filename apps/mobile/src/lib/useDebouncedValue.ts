import { useEffect, useState } from "react";

export function useDebouncedValue<A>(value: A, delayMs: number): A {
  const [debounced, setDebounced] = useState(value);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Publish the value after the delay and clear the timer on change.
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [delayMs, value]);

  return debounced;
}
