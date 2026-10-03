let a, n, r, t, i;
let __tla = (async ()=>{
    var e;
    t = async function() {
        if (e == null) {
            let t = await import("./buttplug_wasm-fizz.js");
            await t.default(), e = t;
        }
    };
    n = function(t) {
        return e.buttplug_create_embedded_wasm_server(t);
    };
    r = function(t) {
        e.buttplug_free_embedded_wasm_server(t);
    };
    i = function(t, n, r) {
        e.buttplug_client_send_json_message(t, n, r);
    };
    a = function(t = "debug") {
        e.buttplug_activate_env_logger(t);
    };
})();
export { a as activateLogging, n as createServer, r as freeServer, t as loadButtplugWasm, i as sendMessage, __tla };
