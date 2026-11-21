import { adaptOrtBindings, adaptOrtImports, adaptPdfWorker } from "./runtime-adapters"

const root = Bun.fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]$/u, "")
const out = `${root}/public/runtime`
const expected = new Map<string, Set<string>>()
let copied = 0
let reused = 0

// Runtime binaries are large. Preserve identical files across dev and release
// builds rather than deleting and copying the entire runtime on every rebuild.
async function copyAsset(source: string, target: string, directory: string) {
	const files = expected.get(directory) ?? new Set<string>()
	expected.set(directory, files)
	files.add(target.slice(directory.length + 1))
	const input = Bun.file(source)
	const output = Bun.file(target)
	if (await output.exists()) {
		if (input.size === output.size && Bun.hash(await input.arrayBuffer()) === Bun.hash(await output.arrayBuffer())) {
			reused++
			return
		}
	}
	await Bun.write(target, input)
	copied++
}

async function copyDirectory(source: string, target: string, directory: string, rename = (file: string) => file) {
	for await (const file of new Bun.Glob("**/*").scan({ cwd: source, onlyFiles: true, dot: true }))
		await copyAsset(`${source}/${file}`, `${target}/${rename(file)}`, directory)
}

async function removeStaleAssets(directory: string) {
	const files = expected.get(directory)!
	for await (const file of new Bun.Glob("**/*").scan({ cwd: directory, onlyFiles: true, dot: true }))
		if (!files.has(file)) await Bun.file(`${directory}/${file}`).delete()
}
const instrumentation = await Bun.build({
	entrypoints: [`${root}/src/speech/instrument-worker.ts`],
	outdir: out,
	naming: "instrument.js",
	target: "browser",
	format: "esm",
	// Remove machine-specific module-path comments, retaining license comments.
	minify: { whitespace: true },
})
if (!instrumentation.success) throw new AggregateError(instrumentation.logs, "Voice preparation worker bundling failed")
expected.set(out, new Set(["instrument.js"]))
for (const [directory, backend, runtime] of [
	["cpu", "wasm", "wasm"],
	["gpu", "webgpu", "webgpu"],
] as const) {
	const result = await Bun.build({
		entrypoints: [`${root}/src/speech/worker.ts`],
		outdir: `${out}/${directory}`,
		naming: "speech.js",
		target: "browser",
		format: "esm",
		minify: { whitespace: true },
		define: { SPEECH_BACKEND: JSON.stringify(backend) },
		plugins: [
			{
				name: "speech-runtime",
				setup(build) {
					build.onResolve({ filter: /^onnxruntime-web$/ }, () => ({
						path: `${root}/node_modules/onnxruntime-web/dist/ort.${runtime}.min.mjs`,
					}))
				},
			},
		],
	})
	if (!result.success) throw new AggregateError(result.logs, "Speech worker bundling failed")
	await Bun.write(
		`${out}/${directory}/speech.js`,
		adaptOrtImports(await Bun.file(`${out}/${directory}/speech.js`).text(), backend),
	)
	expected.get(out)!.add(`${directory}/speech.js`)
	const name = `ort-wasm-simd-threaded${backend === "wasm" ? "" : ".asyncify"}`
	for (const suffix of ["mjs", "wasm"])
		await copyAsset(
			`${root}/node_modules/onnxruntime-web/dist/${name}.${suffix}`,
			`${out}/ort/${backend}/${name}.${suffix}`,
			out,
		)
}
const decoder = await Bun.build({
	entrypoints: [`${root}/src/speech/decoder-worker.ts`],
	outdir: `${out}/cpu`,
	naming: "decoder.js",
	target: "browser",
	format: "esm",
	minify: { whitespace: true },
	plugins: [
		{
			name: "vocoder-runtime",
			setup(build) {
				build.onResolve({ filter: /^onnxruntime-web$/ }, () => ({
					path: `${root}/node_modules/onnxruntime-web/dist/ort.wasm.min.mjs`,
				}))
			},
		},
	],
})
if (!decoder.success) throw new AggregateError(decoder.logs, "Vocoder worker bundling failed")
await Bun.write(`${out}/cpu/decoder.js`, adaptOrtImports(await Bun.file(`${out}/cpu/decoder.js`).text(), "wasm"))
expected.get(out)!.add("cpu/decoder.js")
const gpuModule = `${out}/ort/webgpu/ort-wasm-simd-threaded.asyncify.mjs`
await Bun.write(gpuModule, adaptOrtBindings(await Bun.file(gpuModule).text()))
const phonemizer = `${root}/node_modules/@spelling-creator/spellophone`
// Chrome rejects a second manifest.json anywhere in the extension archive.
// The speech loader maps its inventory request to this packaged filename.
await copyDirectory(`${phonemizer}/espeak-ng-data`, `${out}/espeak-ng-data`, out, (file) =>
	file === "manifest.json" ? "data-index.json" : file,
)
await copyAsset(`${phonemizer}/wasm/espeak-ng.wasm`, `${out}/espeak-ng.wasm`, out)
for (const [source, target] of [
	[`${root}/LICENSE`, "read-aloud-MIT.txt"],
	[`${root}/NOTICE.md`, "read-aloud-notices.txt"],
	[`${phonemizer}/LICENSE`, "spellophone-GPL-3.0.txt"],
	[`${root}/vendor/espeak-ng/licenses/COPYING`, "espeak-ng-GPL-3.0.txt"],
	[`${root}/vendor/espeak-ng/licenses/COPYING.APACHE`, "espeak-ng-Apache-2.0.txt"],
	[`${root}/vendor/espeak-ng/licenses/COPYING.BSD2`, "espeak-ng-BSD-2-Clause.txt"],
	[`${root}/vendor/espeak-ng/licenses/COPYING.UCD`, "espeak-ng-Unicode.txt"],
	[`${root}/vendor/espeak-ng/licenses/FILE-NOTICES.txt`, "espeak-ng-file-notices.txt"],
	[`${root}/vendor/wxt/LICENSE`, "wxt-MIT.txt"],
	[`${root}/vendor/emscripten/LICENSE`, "emscripten-license.txt"],
	[`${root}/vendor/emscripten/musl-COPYRIGHT`, "emscripten-musl.txt"],
	[`${root}/vendor/emscripten/libcxx-LICENSE`, "emscripten-libcxx.txt"],
	[`${root}/vendor/emscripten/libcxxabi-LICENSE`, "emscripten-libcxxabi.txt"],
	[`${root}/vendor/onnxruntime/LICENSE`, "onnxruntime-MIT.txt"],
	[`${root}/vendor/onnxruntime/ThirdPartyNotices.txt`, "onnxruntime-third-party.txt"],
	[`${root}/vendor/onnx/LICENSE`, "onnx-Apache-2.0.txt"],
] as const)
	await copyAsset(source, `${out}/licenses/${target}`, out)
const pdf = `${root}/node_modules/pdfjs-dist`
const pdfOut = `${root}/public/pdf-runtime`
expected.set(pdfOut, new Set(["pdf.worker.mjs"]))
await Bun.write(`${pdfOut}/pdf.worker.mjs`, adaptPdfWorker(await Bun.file(`${pdf}/build/pdf.worker.mjs`).text()))
await copyAsset(`${pdf}/LICENSE`, `${pdfOut}/LICENSE`, pdfOut)
for (const folder of ["cmaps", "standard_fonts", "wasm", "iccs"])
	await copyDirectory(`${pdf}/${folder}`, `${pdfOut}/${folder}`, pdfOut)
// PDF's decoder notices do not include the embedded Rust/binding runtime.
for (const [source, target] of [
	["wasm-bindgen-LICENSE-MIT.txt", "LICENSE_WASM_BINDGEN"],
	["rust-LICENSE-MIT.txt", "LICENSE_RUST"],
	["rust-COPYRIGHT.txt", "COPYRIGHT_RUST"],
	["rust-Unicode-3.0.txt", "LICENSE_RUST_UNICODE"],
	["dlmalloc-LICENSE-MIT.txt", "LICENSE_DLMALLOC"],
	["rust-compiler-builtins-LICENSE.txt", "LICENSE_RUST_COMPILER_BUILTINS"],
	["rust-libm-LICENSE.txt", "LICENSE_RUST_LIBM"],
	["llvm-compiler-rt-CREDITS.txt", "CREDITS_LLVM_COMPILER_RT"],
] as const)
	await copyAsset(`${root}/vendor/source/recipes/qcms-runtime/${source}`, `${pdfOut}/wasm/${target}`, pdfOut)
await removeStaleAssets(out)
await removeStaleAssets(pdfOut)
console.log(`Prepared local runtimes: ${copied} assets copied, ${reused} unchanged. No voice models were downloaded.`)
