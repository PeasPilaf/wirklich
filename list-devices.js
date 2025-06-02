const { devices } = require("playwright");

console.log("Available Playwright Device Names:");
console.log("===================================");
const deviceNames = Object.keys(devices);

console.log("\n--- All Devices ---");
deviceNames.forEach((deviceName) => {
  console.log(`"${deviceName}"`);
});
console.log("===================================");
console.log(`\nTotal devices: ${deviceNames.length}`);
