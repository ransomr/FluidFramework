/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import {
    IFluidHandle,
    IFluidHandleContext,
    FluidObject,
} from "@fluidframework/core-interfaces";
import { generateHandleContextPath } from "@fluidframework/runtime-utils";

export class FluidObjectHandle<T extends FluidObject = FluidObject> implements IFluidHandle {
    private readonly pendingHandlesToMakeVisible: Set<IFluidHandle> = new Set();
    public readonly absolutePath: string;

    public get IFluidHandle(): IFluidHandle { return this; }

    public get isAttached(): boolean {
        return this.routeContext.isAttached;
    }

    /**
     * Tells whether the object of this handle is visible in the container locally or globally.
     */
    private get visible(): boolean {
        /**
         * If the object of this handle is attached, it is visible in the container. Ideally, checking local visibility
         * should be enough for a handle. However, there are scenarios where the object becomes locally visible but the
         * handle does not know this - This will happen is attachGraph is never called on the handle. Couple of examples
         * where this can happen:
         * 1. Handles to DDS other than the default handle won't know if the DDS becomes visible after the handle was
         *    created.
         * 2. Handles to root data stores will never know that it was visible because the handle will not be stores in
         *    another DDS and so, attachGraph will never be called on it.
         */
        return this.isAttached || this.locallyVisible;
    }

    // Tracks whether this handle is locally visible in the container.
    private locallyVisible: boolean = false;

    /**
     * Creates a new FluidObjectHandle.
     * @param value - The FluidObject object this handle is for.
     * @param path - The path to this handle relative to the routeContext.
     * @param routeContext - The parent IFluidHandleContext that has a route to this handle.
     */
    constructor(
        protected readonly value: T,
        public readonly path: string,
        public readonly routeContext: IFluidHandleContext,
    ) {
        this.absolutePath = generateHandleContextPath(path, this.routeContext);
    }

    public async get(): Promise<any> {
        return this.value;
    }

    public attachGraph(): void {
        if (this.visible) {
            return;
        }

        this.locallyVisible = true;
        this.pendingHandlesToMakeVisible.forEach((handle) => {
            handle.attachGraph();
        });
        this.pendingHandlesToMakeVisible.clear();
        this.routeContext.attachGraph();
    }

    public bind(handle: IFluidHandle) {
        // If this handle is visible, attach the graph of the incoming handle as well.
        if (this.visible) {
            handle.attachGraph();
            return;
        }
        this.pendingHandlesToMakeVisible.add(handle);
    }
}
