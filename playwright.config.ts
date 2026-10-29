import config from "./playwright.production.config";
export default { ...config, testDir: "./tests/e2e", fullyParallel: false };
