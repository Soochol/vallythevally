import { createContext, useContext } from "react";

const WindowVisibleContext = createContext(true);

export const WindowVisibleProvider = WindowVisibleContext.Provider;

export function useWindowVisible(): boolean {
  return useContext(WindowVisibleContext);
}
