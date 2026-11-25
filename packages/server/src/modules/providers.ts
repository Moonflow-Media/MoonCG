import { isSafeRelativePath, MoonCGError } from '@mooncg/core';
import type { AuthProvider } from '@mooncg/sdk/module';
import { isExternalProviderId, type LoginResult } from '../auth/auth.js';

/** The id of signing in with a password kept by this server. */
export const LOCAL_PROVIDER = 'local';

/**
 * A way to sign in with a user name and a password. The server has one, `local`, which its
 * internal module `auth-local` registers. Modules cannot add one: the public module API has
 * providers that send the browser elsewhere only.
 */
export interface PasswordProvider {
  readonly id: string;
  readonly name: string;
  login(name: string, password: string, address: string): Promise<LoginResult>;
}

/** An external provider with the module that registered it. */
export interface RegisteredProvider {
  /** The name of the module. */
  readonly owner: string;
  /** The folder of the module, which the icon is read from. */
  readonly dir: string;
  readonly provider: AuthProvider;
}

/** A way to sign in as the login page and the API tell it. */
export type DescribedProvider =
  | { readonly id: string; readonly kind: 'password'; readonly name: string }
  | {
      readonly id: string;
      readonly kind: 'redirect';
      readonly name: string;
      /** Where the icon is served, if the provider has one. */
      readonly icon?: string;
    };

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const ICON = /\.(svg|png)$/i;
const MAX_NAME_LENGTH = 60;

const wrong = (problem: string) => new MoonCGError('invalid', problem);

/** Throws unless the value is a provider a module may register. */
function checkProvider(provider: unknown): asserts provider is AuthProvider {
  const given = (typeof provider === 'object' && provider !== null ? provider : {}) as Record<
    string,
    unknown
  >;
  const { id, name, icon, allowSignup, authorize, callback } = given;
  if (!isExternalProviderId(id)) {
    throw wrong(
      `A provider needs an id of lowercase letters, digits and single dashes, and "${LOCAL_PROVIDER}" is taken`,
    );
  }
  if (
    typeof name !== 'string' ||
    name.trim() === '' ||
    name.length > MAX_NAME_LENGTH ||
    CONTROL.test(name)
  ) {
    throw wrong(`The provider "${id}" needs a name of at most ${MAX_NAME_LENGTH} characters`);
  }
  if (
    icon !== undefined &&
    (typeof icon !== 'string' || !isSafeRelativePath(icon) || !ICON.test(icon))
  ) {
    throw wrong(`The icon of the provider "${id}" must be an .svg or .png file in the module`);
  }
  if (allowSignup !== undefined && typeof allowSignup !== 'boolean') {
    throw wrong(`"allowSignup" of the provider "${id}" must be true or false`);
  }
  if (typeof authorize !== 'function' || typeof callback !== 'function') {
    throw wrong(`The provider "${id}" needs the functions "authorize" and "callback"`);
  }
}

/**
 * Every way to sign in, built-in or from a module, in the order it was registered. Signing in
 * with a password goes through here like signing in elsewhere does: the login route asks
 * this registry for `local`, which is registered the same way a module registers its own.
 */
export class ProviderRegistry {
  readonly #password = new Map<string, PasswordProvider>();
  readonly #external = new Map<string, RegisteredProvider>();

  /** Registers a password provider. Returns what removes it again. */
  addPassword(provider: PasswordProvider): () => void {
    if (this.#password.has(provider.id) || this.#external.has(provider.id)) {
      throw new MoonCGError('conflict', `The provider id "${provider.id}" is taken`);
    }
    this.#password.set(provider.id, provider);
    return () => {
      if (this.#password.get(provider.id) === provider) this.#password.delete(provider.id);
    };
  }

  /**
   * Registers an external provider for a module. Throws for one that is not well-formed and
   * for an id that is taken, by whomever: the links of users to accounts are stored by this
   * id, so a second provider of an id would sign in as the users of the first.
   */
  add(owner: string, dir: string, provider: AuthProvider): () => void {
    checkProvider(provider);
    if (this.#external.has(provider.id) || this.#password.has(provider.id)) {
      throw new MoonCGError('conflict', `The provider id "${provider.id}" is taken`);
    }
    const registered: RegisteredProvider = { owner, dir, provider };
    this.#external.set(provider.id, registered);
    return () => {
      if (this.#external.get(provider.id) === registered) this.#external.delete(provider.id);
    };
  }

  password(id: string): PasswordProvider | undefined {
    return this.#password.get(id);
  }

  get(id: string): RegisteredProvider | undefined {
    return this.#external.get(id);
  }

  /** The external providers, for the login page. */
  external(): RegisteredProvider[] {
    return [...this.#external.values()];
  }

  /** The ids of the external providers a module registered. */
  of(owner: string): string[] {
    return this.external()
      .filter((registered) => registered.owner === owner)
      .map(({ provider }) => provider.id);
  }

  /** Every way to sign in, passwords first. */
  describe(): DescribedProvider[] {
    return [
      ...[...this.#password.values()].map(({ id, name }) => ({
        id,
        kind: 'password' as const,
        name,
      })),
      ...this.external().map(({ provider: { id, name, icon } }) => ({
        id,
        kind: 'redirect' as const,
        name,
        ...(icon === undefined ? {} : { icon: `/auth/${id}/icon` }),
      })),
    ];
  }
}
