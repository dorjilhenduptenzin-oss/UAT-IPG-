const os = require("os");
const path = require("path");

function isServerlessReadonlyRuntime() {
  return Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.LAMBDA_TASK_ROOT);
}

function getDataRootDir() {
  if (process.env.DATA_DIR) {
    return process.env.DATA_DIR;
  }
  if (isServerlessReadonlyRuntime()) {
    // Serverless deployments (including Vercel) can write only to temporary storage.
    return path.join(os.tmpdir(), "uat-ipg-testing", "data");
  }
  return path.join(process.cwd(), "data");
}

module.exports = {
  getDataRootDir,
  isServerlessReadonlyRuntime
};