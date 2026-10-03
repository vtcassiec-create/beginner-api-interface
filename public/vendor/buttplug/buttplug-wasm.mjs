import { EventEmitter as e } from "https://esm.sh/eventemitter3@5.0.4";
import { activateLogging as t, createServer as n, freeServer as r, loadButtplugWasm as i, sendMessage as a } from "./buttplug-wasm-blob.mjs";
//#region src/index.ts
var o = class o extends e {
	constructor(...e) {
		super(...e), this._connected = !1, this.handle = null, this.initialize = async () => {}, this.connect = async () => {
			await i(), this.handle = n((e) => {
				this.emitMessage(e);
			}), this._connected = !0;
		}, this.disconnect = async () => {
			this.handle != null && (r(this.handle), this.handle = null), this._connected = !1;
		}, this.send = (e) => {
			a(this.handle, new TextEncoder().encode("[" + JSON.stringify(e) + "]"), (e) => {
				this.emitMessage(e);
			});
		}, this.emitMessage = (e) => {
			this.emit("message", JSON.parse(new TextDecoder().decode(e)));
		};
	}
	static {
		this._loggingActivated = !1;
	}
	get Connected() {
		return this._connected;
	}
	static {
		this.activateLogging = async (e = "debug") => {
			o._loggingActivated ||= (await i(), t(e), !0);
		};
	}
};
//#endregion
export { o as ButtplugWasmClientConnector };
