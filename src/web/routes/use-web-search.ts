import { useEffect, useState } from "react";

import { readStoredWebSearch, storeWebSearch } from "./assistant-storage.ts";

/** The composer's web search switch, remembered per browser; read after mount, since the server render has no storage. */
export const useWebSearch = () => {
  const [on, setOn] = useState(false);
  useEffect(() => setOn(readStoredWebSearch()), []);
  const change = (next: boolean) => {
    setOn(next);
    storeWebSearch(next);
  };
  return { on, change };
};
