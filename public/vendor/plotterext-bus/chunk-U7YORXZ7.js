import {
  BusEndpoint,
  EVENT_HANDSHAKE,
  EVENT_READY,
  RPC_ERRORS,
  RpcError,
  windowPort
} from "./chunk-HSPWIKMI.js";

// src/extension.ts
var ExtensionClient = class {
  handshake;
  endpoint;
  constructor(endpoint, handshake) {
    this.endpoint = endpoint;
    this.handshake = handshake;
  }
  get context() {
    return this.handshake.context;
  }
  get apiVersion() {
    return this.handshake.apiVersion;
  }
  get capabilities() {
    return this.handshake.capabilities;
  }
  hasCapability(id) {
    return this.handshake.capabilities.includes(id);
  }
  /**
   * Call a host API method. `opts.transfer` moves the listed objects instead
   * of copying them — only `overlay.frame` needs it in this version.
   */
  call(method, params, opts) {
    return this.endpoint.call(method, params, opts);
  }
  /** Send a notification to the host. */
  notify(method, params) {
    this.endpoint.notify(method, params);
  }
  /**
   * Subscribe to host events matching wildcard patterns. Registers both the
   * host-side forwarding subscription and local dispatch; the returned
   * function tears down both.
   */
  async subscribe(patterns, handler) {
    const off = this.endpoint.onEvent(patterns, handler);
    let subscriptionId;
    try {
      const result = await this.call("events.subscribe", { patterns });
      subscriptionId = result.subscriptionId;
    } catch (err) {
      off();
      throw err;
    }
    return async () => {
      off();
      await this.call("events.unsubscribe", { subscriptionId }).catch(() => {
      });
    };
  }
  /**
   * Publish an event onto the bus (capability `events.publish`). The host
   * delivers it to every context in `scope` whose subscriptions match —
   * including this one — exactly as it delivers host events. `scope` defaults
   * to `'all'` (any extension); `'extension'` keeps it to this extension's own
   * contexts. Resolves once the host has delivered it; there is no reply.
   */
  async publish(topic, params, scope) {
    await this.call("events.publish", {
      topic,
      ...params !== void 0 ? { params } : {},
      ...scope ? { scope } : {}
    });
  }
  /** Host-persisted key/value state (see spec: State Storage). */
  state = {
    get: async (keys, scope) => {
      const result = await this.call("state.get", {
        ...scope ? { scope } : {},
        ...keys ? { keys } : {}
      });
      return result.values ?? {};
    },
    set: async (values, scope) => {
      await this.call("state.set", {
        ...scope ? { scope } : {},
        values
      });
    }
  };
  /** Signal K data relayed by the host (capabilities signalk.stream / .put). */
  signalk = {
    /**
     * Subscribe to Signal K path values. The host publishes them as
     * `sk.<path>` events; this helper hides the event-name mapping and
     * establishes both the event-forwarding subscription and the host's
     * upstream Signal K subscription.
     */
    subscribe: async (paths, handler) => {
      const patterns = paths.map((p) => `sk.${p}`);
      const offEvents = await this.subscribe(
        patterns,
        (_name, params) => handler(params)
      );
      let subscriptionId;
      try {
        const result = await this.call("signalk.subscribe", { paths });
        subscriptionId = result.subscriptionId;
      } catch (err) {
        await offEvents();
        throw err;
      }
      return async () => {
        await offEvents();
        await this.call("signalk.unsubscribe", { subscriptionId }).catch(
          () => {
          }
        );
      };
    },
    put: (path, value) => {
      return this.call("signalk.put", { path, value });
    }
  };
  /**
   * The host's visible routes (capability `routes`). Thin **typed** wrappers over
   * the host's `route.*` methods — each just delegates to `this.call(...)`, so a
   * plain-JS extension can call `client.call('route.replace', …)` directly and a
   * TypeScript extension gets the typed `client.route.replace(…)` sugar with no
   * behavioural difference. Follow lifecycle + mutations by subscribing to
   * `route.**` events (`RouteVisibleEvent` / `RouteDirtyEvent` / `RouteSavedEvent`
   * / `RouteHiddenEvent`). Further operations (rename/point ops) extend this
   * surface as the capability fills out.
   */
  route = {
    list: async () => {
      const result = await this.call("route.list");
      return result.routes ?? [];
    },
    create: async (opts) => {
      return await this.call("route.create", opts);
    },
    get: async (routeId) => {
      return await this.call("route.get", { routeId });
    },
    replace: async (routeId, points) => {
      return await this.call("route.replace", { routeId, points });
    },
    save: async (routeId, opts) => {
      return await this.call("route.save", {
        routeId,
        ...opts ?? {}
      });
    },
    show: async (ref) => {
      return await this.call("route.show", { ref });
    },
    hide: async (routeId) => {
      await this.call("route.hide", { routeId });
    },
    delete: async (routeId) => {
      await this.call("route.delete", { routeId });
    }
  };
  /**
   * The host's chart layers (capability `charts`). Thin **typed** wrappers over
   * the host's `chart.*` methods — a lightweight facade over the charts the host
   * already manages: enumerate them, toggle visibility, opacity and stacking
   * order (all batch). It does not create, add, or delete chart sources. Follow
   * changes (from any origin, including the host's own chart controls) by
   * subscribing to `chart.**` events (`ChartVisibilityEvent` / `ChartOpacityEvent`
   * / `ChartOrderEvent` / `ChartTimeEvent`) and re-reading `chart.list` where
   * needed. As with every wrapper, a plain-JS extension can call
   * `client.call('chart.list', …)` directly with no behavioural difference.
   */
  chart = {
    list: async () => {
      const result = await this.call("chart.list");
      return result.charts ?? [];
    },
    setVisibility: async (ids, visible) => {
      await this.call("chart.setVisibility", { ids, visible });
    },
    setOpacity: async (ids, opacity) => {
      await this.call("chart.setOpacity", { ids, opacity });
    },
    setOrder: async (order) => {
      await this.call("chart.setOrder", { order });
    },
    /**
     * Retarget time-varying charts to an ISO 8601 instant, or back to their
     * live frame with `null` (sub-capability `charts.time`). Follow changes via
     * the `chart.time` event (`ChartTimeEvent`).
     */
    setTime: async (ids, time) => {
      await this.call("chart.setTime", { ids, time });
    }
  };
  /**
   * The host's night-vision display mode (capability `nightMode`). Read the
   * current `{ enabled, auto }` state, change it, and follow changes by
   * subscribing to the `nightMode.changed` event (`NightModeChangedEvent`).
   * `set` expresses the three states the spec defines: force on
   * (`{ enabled: true }`), force off (`{ enabled: false }`), follow the server
   * (`{ auto: true }`); setting `enabled` implies `auto: false`. As with every
   * wrapper, a plain-JS extension can call `client.call('nightMode.get' |
   * 'nightMode.set', …)` directly with no behavioural difference.
   */
  nightMode = {
    get: async () => {
      return await this.call("nightMode.get");
    },
    set: async (state) => {
      await this.call("nightMode.set", state);
    }
  };
  /**
   * Panel visibility (capability `panels.state`): the state of each of this
   * extension's loaded panels. Follow changes with the `panel.state` event,
   * which every context of the extension receives; subscribe first, then
   * `list()`, so no change is missed. A plain-JS extension can call
   * `client.call('ui.listPanels')` with no behavioural difference.
   */
  panels = {
    list: async () => {
      const r = await this.call("ui.listPanels");
      return r.panels;
    }
  };
  /**
   * Map overlays. `list()`, `setVisibility()` and `setOpacity()` apply to both
   * kinds, and the host reports visibility with `overlay.state`
   * (`OverlayStateEvent`).
   *
   * Image overlays (capability `overlays.image`): map layers this extension's
   * background runtime draws. The host asks for frames with the
   * `overlay.request` event (`OverlayRequestEvent`); the runtime answers each
   * request with `frame()`, keeping one frame in flight. `frame()` transfers
   * `image`, so the caller no longer owns it afterwards. A plain-JS extension
   * can call `client.call('overlay.frame', params, { transfer: [image] })`
   * with no behavioural difference.
   *
   * Data overlays (capability `overlays.data`): map layers the host draws from
   * the extension's data and MapLibre style. `refresh()`, `setData()`,
   * `setLayer()` and `setState()` change one while it is shown.
   */
  overlays = {
    list: async () => {
      const r = await this.call("overlay.list");
      return r.overlays;
    },
    setVisibility: async (ids, visible) => {
      await this.call("overlay.setVisibility", { ids, visible });
    },
    setOpacity: async (ids, opacity) => {
      await this.call("overlay.setOpacity", { ids, opacity });
    },
    frame: async (params) => {
      return await this.call("overlay.frame", params, {
        transfer: [params.image]
      });
    },
    refresh: async (params) => {
      await this.call("overlay.refresh", params);
    },
    setData: async (params) => {
      await this.call("overlay.setData", params);
    },
    setLayer: async (params) => {
      await this.call("overlay.setLayer", params);
    },
    setState: async (overlayId, values) => {
      await this.call("overlay.setState", { overlayId, values });
    }
  };
  /**
   * Floating windows (capability `windows`): show one of this extension's
   * iframe panels in a window over the chart. Geometry is a request — read the
   * actual `bounds` from the returned `WindowState`, and follow changes with
   * the `window.bounds` / `window.state` / `window.closed` events. Windows
   * belong to the extension, so any of its contexts may manage them; in a
   * `window` context, `update` / `focus` / `close` default to the window
   * itself when `windowId` is left out. A plain-JS extension can call
   * `client.call('ui.openWindow', …)` and friends directly with no
   * behavioural difference.
   */
  windows = {
    open: async (params) => {
      return await this.call("ui.openWindow", params);
    },
    update: async (params) => {
      return await this.call("ui.updateWindow", params);
    },
    focus: async (windowId) => {
      await this.call("ui.focusWindow", windowId === void 0 ? {} : { windowId });
    },
    close: async (windowId) => {
      await this.call("ui.closeWindow", windowId === void 0 ? {} : { windowId });
    },
    list: async () => {
      const r = await this.call("ui.listWindows");
      return r.windows;
    }
  };
  /**
   * Apply a stored resource group to the host's display (capability
   * `resourceGroups`). Resolves to `{ applied }` — the types the host made a
   * best-effort attempt to carry out; a type it did not act on is omitted.
   * Follow applies from any origin (including the user's own group picker) via
   * the `resourceGroup.applied` event (`ResourceGroupAppliedEvent`). Group CRUD
   * is not here: use the server's resources API (`/resources/groups`). A
   * plain-JS extension can call `client.call('resourceGroup.apply', { id })`
   * directly with no behavioural difference.
   */
  resourceGroup = {
    apply: async (id) => {
      return await this.call("resourceGroup.apply", {
        id
      });
    }
  };
  /**
   * The host's chart viewport (capability `map`). Read the current
   * `{ center, zoom, bounds }`, drive it, and follow it by subscribing to the
   * `map.view` event (`MapViewEvent`), which carries the same shape and fires
   * once per settled pan/zoom. Seed with `getView` so a follower has a view
   * before the first change. As with every wrapper, a plain-JS extension can
   * call `client.call('map.getView' | 'map.center' | 'map.fitBounds', …)`
   * directly with no behavioural difference.
   */
  map = {
    getView: async () => {
      return await this.call("map.getView");
    },
    center: async (position, zoom) => {
      await this.call("map.center", {
        position,
        ...typeof zoom === "number" ? { zoom } : {}
      });
    },
    /**
     * Fit the chart to `[west, south, east, north]`. A box crossing the
     * antimeridian may be given as `west > east` (the API's form) or unwrapped
     * (`east` past 180); the host fits it the short way round.
     */
    fitBounds: async (bounds) => {
      await this.call("map.fitBounds", { bounds });
    },
    /**
     * Ask the user to pick a point or feature (capability `map.pick`). Resolves
     * at once with the `pickId`; the answer arrives later as the `map.picked`
     * event (`MapPickedEvent`), delivered only to this context — subscribe to
     * it before calling.
     */
    pick: async (params = {}) => {
      return await this.call("map.pick", params);
    },
    /** End this context's pick if it is still on. Resolves either way. */
    cancelPick: async (pickId) => {
      await this.call("map.cancelPick", { pickId });
    }
  };
  /**
   * The extension's manifest actions (capability `actions`). The host offers
   * them on chart targets and reports a choice with the `action.invoked` event
   * (`ActionInvokedEvent`), or in `context.invocation` for a panel or window
   * the action loaded. `setVisibility` shows and hides actions that depend on
   * the extension's state; it is not persisted, so set it again on load.
   */
  actions = {
    setVisibility: async (ids, visible) => {
      await this.call("actions.setVisibility", { ids, visible });
    }
  };
  /**
   * The extension's toolbar buttons. `setVisibility` (capability
   * `buttons.visibility`) shows and hides them; `decorate` (capability
   * `buttons.decorations`) sets their style, custom colours and badge. Neither
   * is persisted, so set them again on load.
   */
  buttons = {
    setVisibility: async (ids, visible) => {
      await this.call("buttons.setVisibility", { ids, visible });
    },
    decorate: async (ids, decorations) => {
      await this.call("buttons.decorate", { ...decorations, ids });
    }
  };
  close() {
    this.endpoint.close();
  }
};
function connectExtension(opts = {}) {
  const port = opts.port ?? windowPort(globalThis.parent, {
    origin: "*"
  });
  const endpoint = new BusEndpoint({
    port,
    callTimeoutMs: opts.callTimeoutMs,
    onError: opts.onError
  });
  const readyParams = opts.id ? { id: opts.id } : void 0;
  return new Promise((resolve, reject) => {
    let done = false;
    const off = endpoint.onEvent([EVENT_HANDSHAKE], (_name, params) => {
      if (done) return;
      done = true;
      cleanup();
      resolve(new ExtensionClient(endpoint, params));
    });
    const interval = setInterval(
      () => endpoint.notify(EVENT_READY, readyParams),
      opts.readyIntervalMs ?? 250
    );
    const timeout = setTimeout(() => {
      if (done) return;
      done = true;
      cleanup();
      endpoint.close();
      reject(
        new RpcError("Timed out waiting for host handshake", {
          code: RPC_ERRORS.TIMEOUT,
          reason: "HANDSHAKE_TIMEOUT"
        })
      );
    }, opts.timeoutMs ?? 1e4);
    const cleanup = () => {
      off();
      clearInterval(interval);
      clearTimeout(timeout);
    };
    endpoint.notify(EVENT_READY, readyParams);
  });
}

export {
  ExtensionClient,
  connectExtension
};
//# sourceMappingURL=chunk-U7YORXZ7.js.map