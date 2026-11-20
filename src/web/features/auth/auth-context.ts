import { createContext, useContext } from 'react';

/** What the signed-in app knows about access control (provided by AuthGate). */
export interface Auth {
  /** An owner password is set: the header offers Logout. */
  passwordSet: boolean;
  /** Ends this browser's session and shows the Login page. */
  logout(): Promise<void>;
  /** The password was set or changed from Settings (this browser holds the new session). */
  passwordChanged(): void;
}

export const AuthContext = createContext<Auth | null>(null);

/** The auth state, or null outside an AuthGate (e.g. isolated component tests). */
export function useAuth(): Auth | null {
  return useContext(AuthContext);
}
