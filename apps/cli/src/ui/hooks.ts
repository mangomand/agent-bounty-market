import { useApp } from "ink";
import { useEffect, useState } from "react";

/** Load once, then exit the Ink app (with the error, if any) after the result renders. */
export function useOneShot<T>(load: () => Promise<T>): { data?: T; error?: Error } {
  const { exit } = useApp();
  const [state, setState] = useState<{ data?: T; error?: Error }>({});
  useEffect(() => {
    let live = true;
    load().then(
      (data) => live && setState({ data }),
      (err: unknown) => live && setState({ error: err instanceof Error ? err : new Error(String(err)) }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load runs once by design
  }, []);
  useEffect(() => {
    if (state.error) exit(state.error);
    else if (state.data !== undefined) exit();
  }, [state, exit]);
  return state;
}
