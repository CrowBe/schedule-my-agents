declare module '*.wasm' { const wasmModule: WebAssembly.Module; export default wasmModule; }
declare module '*.pem?raw' { const value:string; export default value; }
