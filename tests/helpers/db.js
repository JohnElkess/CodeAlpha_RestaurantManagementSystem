'use strict';
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
require('../../src/config/db'); // registers every model

let memoryServer;

// mongodb driver 7 loads Node's `os` module with a dynamic import(), which Jest's CommonJS sandbox cannot run,
// so inside Jest the driver would send an incomplete client handshake that recent MongoDB servers reject
// ("Missing required sub-document 'driver'"). Handing it `os` directly avoids that. Only tests need this.
const driverOptions = { runtimeAdapters: { os: require('os') } };

/**
 * Connects to a throwaway MongoDB. By default an in-memory server is started (downloaded on first use).
 * Set TEST_MONGO_URI (e.g. mongodb://localhost:27017) to use an existing server instead; every test file then
 * gets its own database, which is dropped at the end.
 */
exports.connect = async () => {
  if (process.env.TEST_MONGO_URI) {
    const dbName = `jest_${process.pid}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    await mongoose.connect(process.env.TEST_MONGO_URI, { dbName, ...driverOptions });
  } else {
    memoryServer = await MongoMemoryServer.create();
    await mongoose.connect(memoryServer.getUri(), driverOptions);
  }
  // Wait for index builds: the unique indexes are part of the behaviour under test.
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
};

exports.clear = async () => {
  await Promise.all(Object.values(mongoose.connection.collections).map((c) => c.deleteMany({})));
};

exports.disconnect = async () => {
  if (process.env.TEST_MONGO_URI) await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  if (memoryServer) await memoryServer.stop();
};
