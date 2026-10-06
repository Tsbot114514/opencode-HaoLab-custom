import { plugin } from "bun"
import { createRequire } from "node:module"
import Path from "node:path"

const require = createRequire(import.meta.resolve("vite-plugin-solid"))
const { transformAsync, types } = require("@babel/core")
const transpiler = new Bun.Transpiler({ loader: "ts", trimUnusedImports: true })

// Bun does not compile Solid's DOM JSX. Keep the real providers in browser-conditioned tests.
plugin({
  name: "solid-browser-tests",
  setup(build) {
    // Match Vite's asset handling so integration tests can mount the actual application shell.
    build.onResolve({ filter: /\?(?:worker|url)/ }, (args) => ({ path: args.path, namespace: "test-asset-url" }))
    build.onLoad({ filter: /.*/, namespace: "test-asset-url" }, (args) => ({
      contents: `export default ${JSON.stringify(args.path)}`,
      loader: "js",
    }))
    build.onResolve({ filter: /\.jsx$/ }, (args) => ({
      path: Bun.resolveSync(args.path.replace(/\.jsx$/, ".tsx"), Path.dirname(args.importer)),
    }))
    build.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
      const result = await transformAsync(await Bun.file(path).text(), {
        filename: path,
        parserOpts: { plugins: ["typescript", "jsx"] },
        plugins: [
          () => ({
            visitor: {
              CallExpression(call) {
                const callee = call.node.callee
                if (
                  callee.type !== "MemberExpression" ||
                  callee.object.type !== "MetaProperty" ||
                  callee.property.name !== "glob"
                )
                  return
                const pattern = call.node.arguments[0]?.value
                if (typeof pattern !== "string") throw new Error("Browser tests require a literal asset glob")
                call.replaceWith(
                  types.objectExpression(
                    [...new Bun.Glob(pattern).scanSync({ cwd: Path.dirname(path), onlyFiles: true })].map((file) =>
                      types.objectProperty(
                        types.stringLiteral(`./${file.replace(/^\.\//, "")}`),
                        types.arrowFunctionExpression(
                          [],
                          types.callExpression(types.import(), [
                            types.stringLiteral(Path.resolve(Path.dirname(path), file)),
                          ]),
                        ),
                      ),
                    ),
                  ),
                )
              },
            },
          }),
        ],
        presets: [[require.resolve("babel-preset-solid"), { generate: "dom" }]],
      })
      return { contents: transpiler.transformSync(result?.code ?? ""), loader: "js" }
    })
  },
})
