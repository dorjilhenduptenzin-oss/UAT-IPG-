const app = require("./app");
const { config } = require("./config/env");

app.listen(config.PORT, config.BIND_HOST, () => {
  console.log(`UAT server listening on ${config.BIND_HOST}:${config.PORT}`);
  console.log(`UAT local URL http://localhost:${config.PORT}`);
});
