const { createSeedState } = require("./domain");

function createStore(nowValue) {
  let state = createSeedState(nowValue || new Date());

  return {
    getState() {
      return state;
    },
    reset(nowOverride) {
      state = createSeedState(nowOverride || new Date());
      return state;
    },
  };
}

module.exports = {
  createStore,
};
