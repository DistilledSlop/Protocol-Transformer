'use strict';
// The reader shares the proxy's installed packages (minecraft-protocol, minecraft-data).
const path = require('path');
const nm = path.join(__dirname, '..', 'proxy', 'node_modules');

module.exports = {
    mc: require(path.join(nm, 'minecraft-protocol')),
    minecraftData: require(path.join(nm, 'minecraft-data')),
};
