import type { Auth } from '../auth/auth.js';
import type { InternalModule } from './manager.js';
import { LOCAL_PROVIDER, type PasswordProvider } from './providers.js';

/** Signing in with a user name and a password kept by this server. */
export const localPasswordProvider = (auth: Pick<Auth, 'login'>): PasswordProvider => ({
  id: LOCAL_PROVIDER,
  name: 'Password',
  login: (name, password, address) => auth.login(name, password, address),
});

/**
 * The local login as a module of the server itself. It registers its provider in the same
 * registry the providers of modules are in, and the login route asks that registry: there is
 * one way a way to sign in becomes known, and the built-in one takes it too. It always runs
 * and cannot be disabled, or nobody could sign in to enable it again.
 */
export const authLocalModule = (auth: Pick<Auth, 'login'>): InternalModule => ({
  name: 'auth-local',
  title: 'Local accounts',
  setup(_ctx, internal) {
    internal.registerPasswordProvider(localPasswordProvider(auth));
  },
});
