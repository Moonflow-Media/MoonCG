import { randomUUID } from 'node:crypto';
import {
  bundlePermission,
  type GraphicInstance,
  type GraphicPages,
  type Json,
  type Manifest,
  type ReplicantRegistry,
} from '@mooncg/core';

/**
 * The read-only replicant `<bundle>:$instances.<graphic>` lists the pages that show a graphic
 * right now, each with an id and since when. It takes the permission the graphic itself
 * takes. Who each page acts as is not in it: that is told by the API to whoever may manage
 * bundles. Names that start with `$` are the server's:
 * a manifest cannot declare one.
 */
export const INSTANCES_PREFIX = '$instances.';

type Graphic = Manifest['graphics'][number];

interface Open {
  readonly id: string;
  readonly bundle: string;
  readonly file: string;
  readonly instance: GraphicInstance;
  readonly since: string;
}

/**
 * Knows which graphic pages are connected. A page says in `hello` which graphic it is; its
 * session registers it here and takes it out again when the connection ends. A graphic whose
 * manifest entry says `singleInstance` takes one page at a time: the first one stays.
 */
export class GraphicInstances implements GraphicPages {
  readonly #registry: ReplicantRegistry;
  /** The graphics of each running bundle. */
  readonly #graphics = new Map<string, readonly Graphic[]>();
  readonly #open = new Map<string, Open>();

  constructor(registry: ReplicantRegistry) {
    this.#registry = registry;
  }

  /** Declares the list of each graphic of a bundle that is starting. */
  declare(bundle: string, manifest: Manifest): void {
    this.#graphics.set(bundle, manifest.graphics);
    for (const graphic of manifest.graphics) {
      this.#registry.declare(bundle, `${INSTANCES_PREFIX}${graphic.id}`, {
        // Pages that stayed connected while the bundle was restarted are still there.
        initial: this.#list(bundle, graphic.file),
        readPermission: bundlePermission(bundle, graphic.requires),
        readOnly: true,
      });
    }
  }

  /** Forgets the graphics of a bundle that stopped. Its replicants go with the bundle's. */
  retract(bundle: string): void {
    this.#graphics.delete(bundle);
  }

  find(bundle: string, file: string): { readonly permission: string } | undefined {
    const graphic = this.#graphic(bundle, file);
    return graphic && { permission: bundlePermission(bundle, graphic.requires) };
  }

  enter(bundle: string, file: string, instance: GraphicInstance): (() => void) | undefined {
    const graphic = this.#graphic(bundle, file);
    if (!graphic) return undefined;
    if (graphic.singleInstance) {
      const holders = [...this.#open.values()].filter(
        (open) => open.bundle === bundle && open.file === file,
      );
      // Whoever holds the place keeps it against anyone else. The same principal coming
      // again is the same source being opened anew, such as a scene that was reloaded while
      // the old connection has not yet been noticed to be dead: the new page gets the place.
      if (holders.some((open) => open.instance.principal.id !== instance.principal.id)) {
        return undefined;
      }
      for (const open of holders) {
        this.#open.delete(open.id);
        open.instance.end('replaced');
      }
    }
    const id = randomUUID();
    this.#open.set(id, { id, bundle, file, instance, since: new Date().toISOString() });
    this.#publish(bundle, file);
    return () => {
      if (this.#open.delete(id)) this.#publish(bundle, file);
    };
  }

  /** The bundle and the permission of the graphic a connected page shows. */
  get(id: string): { readonly bundle: string; readonly permission: string } | undefined {
    const open = this.#open.get(id);
    const graphic = open && this.#graphic(open.bundle, open.file);
    return open && graphic
      ? { bundle: open.bundle, permission: bundlePermission(open.bundle, graphic.requires) }
      : undefined;
  }

  /** Tells a connected page to load itself again. Answers whether there is such a page. */
  reload(id: string): boolean {
    const open = this.#open.get(id);
    open?.instance.reload();
    return open !== undefined;
  }

  /**
   * Takes a connected page off its graphic and tells it so; it does not come back by itself.
   * That frees the place of a graphic that takes one instance. Answers whether there was
   * such a page.
   */
  disconnect(id: string): boolean {
    const open = this.#open.get(id);
    if (!open) return false;
    this.#open.delete(id);
    open.instance.end('disconnected');
    this.#publish(open.bundle, open.file);
    return true;
  }

  /**
   * The connected pages of a bundle's graphics with who each acts as. That is more than the
   * replicants tell, and is for whoever manages the installation.
   */
  of(bundle: string): {
    readonly id: string;
    readonly graphic: string;
    readonly principal: GraphicInstance['principal'];
    readonly since: string;
  }[] {
    return [...this.#open.values()].flatMap((open) => {
      const graphic = open.bundle === bundle ? this.#graphic(bundle, open.file) : undefined;
      return graphic
        ? [
            {
              id: open.id,
              graphic: graphic.id,
              principal: open.instance.principal,
              since: open.since,
            },
          ]
        : [];
    });
  }

  #graphic(bundle: string, file: string): Graphic | undefined {
    return this.#graphics.get(bundle)?.find((graphic) => graphic.file === file);
  }

  #list(bundle: string, file: string): Json {
    return [...this.#open.values()]
      .filter((open) => open.bundle === bundle && open.file === file)
      .map(({ id, since }) => ({ id, since }));
  }

  #publish(bundle: string, file: string): void {
    const graphic = this.#graphic(bundle, file);
    const entry = graphic && this.#registry.get(`${bundle}:${INSTANCES_PREFIX}${graphic.id}`);
    entry?.replicant.applyOp({
      patches: [{ op: 'replace', path: '', value: this.#list(bundle, file) }],
    });
  }
}
