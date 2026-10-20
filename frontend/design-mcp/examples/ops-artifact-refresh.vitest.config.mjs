const isolated=process.env.FUTUREOX_ARTIFACT_KERNEL_DIR
export default {resolve:{alias:isolated?[{find:/.*generated\/design-kernel\/design_kernel(?:\.js)?$/,replacement:isolated+'/design_kernel.js'}]:[]},test:{setupFiles:[isolated?'../design-mcp/examples/ops-artifact-isolated-setup.ts':'./src/test-setup.ts'],include:['../design-mcp/examples/ops-artifact-refresh.test.ts'],testTimeout:600000}}
