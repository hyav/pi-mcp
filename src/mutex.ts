/** FIFO Promise-based mutex with cancellable lock acquisition. */
export class SimpleMutex {
	private locked = false;
	private waiters: Array<{
		resolve: (release: () => void) => void;
		reject: (error: Error) => void;
		signal?: AbortSignal;
		onAbort?: () => void;
	}> = [];

	public lock(signal?: AbortSignal): Promise<() => void> {
		if (signal?.aborted) return Promise.reject(this.abortError(signal));
		return new Promise((resolve, reject) => {
			const waiter = { resolve, reject, signal } as (typeof this.waiters)[number];
			if (signal) {
				waiter.onAbort = () => {
					const index = this.waiters.indexOf(waiter);
					if (index >= 0) this.waiters.splice(index, 1);
					reject(this.abortError(signal));
				};
				signal.addEventListener("abort", waiter.onAbort, { once: true });
			}
			if (this.locked) this.waiters.push(waiter);
			else this.grant(waiter);
		});
	}

	private abortError(signal: AbortSignal): Error {
		if (signal.reason instanceof Error) return signal.reason;
		return new Error(typeof signal.reason === "string" ? signal.reason : "Lock acquisition cancelled");
	}

	private grant(waiter: (typeof this.waiters)[number]): void {
		this.locked = true;
		if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
		let released = false;
		waiter.resolve(() => {
			if (released) return;
			released = true;
			this.releaseNext();
		});
	}

	private releaseNext(): void {
		while (this.waiters.length > 0) {
			const next = this.waiters.shift()!;
			if (next.signal?.aborted) {
				if (next.onAbort) next.signal.removeEventListener("abort", next.onAbort);
				next.reject(this.abortError(next.signal));
				continue;
			}
			this.grant(next);
			return;
		}
		this.locked = false;
	}
}
