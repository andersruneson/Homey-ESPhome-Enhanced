'use strict';

const Homey = require('homey');
const { HomeyAPI } = require('../../bundles/homey-api');
const PhysicalDeviceManager = require('./physical-device-manager');

class Driver extends Homey.Driver {
    // Used during pairSession
    homeyApi = null;

    async onInit() {
        //TODO: To be removed!
        this.resetConf();

        // Check for migration or init conf
        this.checkMigration();
        this.initConf();

        this.cleanUpConf();

        PhysicalDeviceManager.init(this);

        // Init each physical device
        let conf = this.getConf();
        conf.forEach(physicalDevice => {
            PhysicalDeviceManager.create(true, physicalDevice.physicalDeviceId, physicalDevice.name, physicalDevice.ipAddress, physicalDevice.port, physicalDevice.encryptionKey, physicalDevice.password);
        });

        this.log('ESPhomeWizard initialized');
    }

    cleanUpConf() {
        this.log('cleanUpConf');

        // Go through all the virtual devices, to build up the list of usefull physical device ids
        // Then remove useless physical device ids from the conf

        // Find the list of physical device ids
        let listPhysicalDeviceIds = [];
        this.getDevices().forEach(virtualDevice => {
            let capabilityKeysV2 = virtualDevice.getStoreValue('capabilityKeysV2');

            // Maybe there are no capabilities
            if (capabilityKeysV2 !== null) {
                Object.keys(capabilityKeysV2).forEach(capabilityKeyV2 => {
                    let capabilityValueV2 = capabilityKeysV2[capabilityKeyV2];
                    if (!listPhysicalDeviceIds.includes(capabilityValueV2.physicalDeviceId)) {
                        listPhysicalDeviceIds.push(capabilityValueV2.physicalDeviceId);
                    }
                });
            }
        });

        let conf = this.getConf();
        conf.forEach(physicalDevice => {
            if (!listPhysicalDeviceIds.includes(physicalDevice.physicalDeviceId)) {
                // We can remove it
                this.log("Removing a physical device from conf (useless): ", physicalDevice.physicalDeviceId);
                conf.splice(conf.indexOf(physicalDevice), 1);
            }
        });
        this.setConf(conf);
    }

    cleanUpPhysicalDevices() {
        this.cleanUpConf();

        // TODO: clean physical devices from the manager
    }

    async onPair(session) {
        await this.initHomeyApi();

        /**
         * Used by update_device view
         * Get the list of existing physical device
         * 
         * return: [
         *     {
         *         id,
         *         ipAddress,
         *         port,
         *         bound
         *     }
         * ]
         */
        session.setHandler('get-existing-physical-devices', () => {
            this.log('get-existing-physical-devices started');

            let result = [];
            try {
                PhysicalDeviceManager.physicalDevices.forEach((physicalDevice) => {
                    // Find num of bound virtual devices
                    let bound = 0;
                    this.getDevices().forEach(device => {
                        if (device.physicalDeviceId === physicalDevice.id) {
                            ++bound;
                        }
                    });

                    result.push({
                        'id': physicalDevice.id,
                        'ipAddress': physicalDevice.client.ipAddress,
                        'port': physicalDevice.client.port,
                        'bound': bound
                    });
                });

                this.log('get-existing-physical-devices result:', result);
            } catch (e) {
                this.error(e);
                throw e;
            }

            return result;
        });

        /**
         * Used by conf_main view
         * Get the initial_configuration
         * 
         * return: refer to store.html
         */
        session.setHandler('get-initial-configuration', (data) => {
            this.log('get-initial-configuration started:', data);
            let mode = data.mode;
            let physicalDeviceId = data.physicalDeviceId;

            this.log('Processed data:', mode, physicalDeviceId);

            let result = {
                physicalDevice: null,
                virtualDevices: [],
                nativeCapabilities: []
            };

            try {
                // Get the physical device
                let physicalDevice = PhysicalDeviceManager.getById(physicalDeviceId);

                // Add physical device to configuration
                result.physicalDevice = {
                    'id': physicalDevice.id,
                    'ipAddress': physicalDevice.client.ipAddress,
                    'port': physicalDevice.client.port,
                    'encryptionKey': physicalDevice.client.encryptionKey,
                    'password': physicalDevice.client.password
                }

                // We will build a list of bound_native_capabilities
                let boundNativeCapabilities = [];

                // Get the virtual devices and add them to configuration
                if (mode === 'existing_physical_device') {
                    this.getDevices().forEach(device => {
                        if (device.physicalDeviceId === physicalDevice.id) {
                            let capabilities = device.getCapabilities();
                            let capabilityKeys = device.getStoreValue('capabilityKeys');

                            let tmp = {
                                'id': device.getData().id,
                                'homeyId': device.getData().id,
                                'name': device.getName(),
                                'nameMustBeChanged': false,
                                'state': 'existing',
                                'capabilities': []
                            };

                            capabilities.forEach(capability => {
                                let nativeCapabilityId = capabilityKeys[capability];
                                tmp.capabilities.push({
                                    'type': capability.split(".")[0],
                                    'name': capability,
                                    'nativeCapabilityId': nativeCapabilityId,
                                    'state': 'unmodified',
                                    'options': device.getCapabilityOptions(capability)
                                });

                                boundNativeCapabilities.push(nativeCapabilityId);
                            });

                            result.virtualDevices.push(tmp);
                        }
                    });
                }

                // Get the native capabilities and add them to configuration
                this.log('Processing native capabilities');
                Object.keys(physicalDevice.nativeCapabilities).forEach(nativeCapabilityId => {
                    let nativeCapability = physicalDevice.nativeCapabilities[nativeCapabilityId];
                    this.log('Processing a native capability:', nativeCapability);

                    let tmp = {
                        'id': nativeCapabilityId,
                        'entityId': nativeCapability.entityId,
                        'entityName': nativeCapability.entityName,
                        'type': nativeCapability.type,
                        'attribut': nativeCapability.attribut,
                        'state': boundNativeCapabilities.includes(nativeCapabilityId) ? 'bound' : 'unbind',
                        'value': nativeCapability.value === null ? (nativeCapability.configs['writeOnly'] === true ? '' : 'undefined') : nativeCapability.value,
                        'configs': nativeCapability.configs,
                        'constraints': nativeCapability.constraints,
                        'specialCase': nativeCapability.specialCase
                    };

                    result.nativeCapabilities.push(tmp);
                });

                this.log('get-initial-configuration result:', result);
            } catch (e) {
                this.error(e);
                throw e;
            }

            return result;
        });

        /**
         * data: {
         *     devices : [
         *         deviceId : string,
         *         capabilities : [string]
         *     ]
         * }
         */
        session.setHandler('remove-capabilities', async (data) => {
            this.log('remove-capabilities started:', data);
            let devices = data.devices;

            try {
                await devices.forEach(async device => {
                    let capabilities = device.capabilities;
                    let realDevices = this.getDevices().filter(realDevice => realDevice.getData().id === device.deviceId);

                    if (realDevices.length !== 1) {
                        this.log('Found', realDevices.length, 'devices for id', device.deviceId, 'expecting only one!');
                    } else {
                        let realDevice = realDevices[0];

                        this.log('Processing device with id', device.deviceId);

                        // Removing capabilityKeys first
                        let capabilityKeys = realDevice.getStoreValue('capabilityKeys');
                        capabilities.forEach(capability => {
                            this.log('Removing capabilityKey:', capability);
                            delete capabilityKeys[capability];
                        });
                        realDevice.setStoreValue('capabilityKeys', capabilityKeys);

                        // Removing capability
                        await capabilities.forEach(async capability => {
                            this.log('Removing capability:', capability);
                            await realDevice.removeCapability(capability);
                        });

                        this.log('Device with id', device.deviceId, 'is processed');
                    }
                });
            } catch (e) {
                this.error(e);
                throw e;
            } finally {
                this.log('remove-capabilities finished');
            }
        });

        /**
         * data: {
         *     devices : [
         *         deviceId: string,
         *         capabilities: [
         *             {
         *                 capabilityName : string,
         *                 nativeCapabilityId : string,
         *                 options : {
         *                     <key: string>: <value: any>
         *                 }
         *             }
         *         ]
         *     ]
         * }
         */
        session.setHandler('add-capabilities', async (data) => {
            this.log('add-capabilities started:', data);
            let devices = data.devices;

            try {
                await devices.forEach(async device => {
                    let capabilities = device.capabilities;
                    let realDevices = this.getDevices().filter(realDevice => realDevice.getData().id === device.deviceId);

                    if (realDevices.length !== 1) {
                        this.log('Found', realDevices.length, 'devices for id', device.deviceId, 'expecting only one!');
                    } else {
                        let realDevice = realDevices[0];

                        this.log('Processing device with id', device.deviceId);

                        // Adding capability first
                        await capabilities.forEach(async capability => {
                            this.log('Adding capability:', capability.capabilityName);
                            await realDevice.addCapability(capability.capabilityName);
                            await realDevice.setCapabilityOptions(capability.capabilityName, capability.options);
                            realDevice._addCapabilityListener(capability.capabilityName, capability.nativeCapabilityId);
                        });

                        // Adding capabilityKeys
                        let capabilityKeys = realDevice.getStoreValue('capabilityKeys');
                        capabilities.forEach(capability => {
                            this.log('Adding capabilityKey:', capability.capabilityName);
                            capabilityKeys[capability.capabilityName] = capability.nativeCapabilityId;
                        });
                        realDevice.setStoreValue('capabilityKeys', capabilityKeys);

                        // Force update current value
                        capabilities.forEach(capability => {
                            realDevice._forceUpdateCurrentValue(capability.capabilityName);
                        });

                        this.log('Device with id', device.deviceId, 'is processed');
                    }
                });
            } catch (e) {
                this.error(e);
                throw e;
            } finally {
                this.log('add-capabilities finished');
            }
        });

        /**
         * data: {
         *     devices : [
         *         deviceId: string,
         *         capabilities: [
         *             {
         *                 capabilityName : string,
         *                 options : {
         *                     <key: string>: <value: any>
         *                 }
         *             }
         *         ]
         *     ]
         * }
         */
        session.setHandler('modify-capabilities', async (data) => {
            this.log('modify-capabilities started:', data);
            let devices = data.devices;

            try {
                await devices.forEach(async device => {
                    let capabilities = device.capabilities;
                    let realDevices = this.getDevices().filter(realDevice => realDevice.getData().id === device.deviceId);

                    if (realDevices.length !== 1) {
                        this.log('Found', realDevices.length, 'devices for id', device.deviceId, 'expecting only one!');
                    } else {
                        let realDevice = realDevices[0];

                        this.log('Processing device with id', device.deviceId);

                        // Modify capability
                        await capabilities.forEach(async capability => {
                            this.log('Modify capability:', capability.capabilityName);
                            await realDevice.setCapabilityOptions(capability.capabilityName, capability.options);
                        });

                        this.log('Device with id', device.deviceId, 'is processed');
                    }
                });
            } catch (e) {
                this.error(e);
                throw e;
            } finally {
                this.log('modify-capabilities finished');
            }
        });

        session.setHandler('logme', (data) => {
            try {
                this.log('browser log:', ...Object.values(data));
            } catch (e) {
                this.error(e);
                throw e;
            }
        });

        session.setHandler('get-settings', (data) => {
            this.log('get-settings started:', data);
            let physicalDeviceId = data.physicalDeviceId;

            let result = null;
            try {
                // Get the first virtual device linked to this physical device
                let firstVirtualDevice = this.getDevices().filter(virtualDevice => virtualDevice.physicalDeviceId === physicalDeviceId)[0];
                const settings = firstVirtualDevice.getSettings();

                result = {
                    'ipAddress': settings.ipAddress,
                    'port': settings.port,
                    'encryptionKey': settings.encryptionKey,
                    'password': settings.password
                };
            } catch (e) {
                this.error(e);
                throw e;
            }

            return result;
        });

        session.setHandler('get-device-classes', (data) => {
            this.log('get-device-classes started:', data);

            let result = [];
            try {
                this.getDevices().forEach(virtualDevice => {
                    let myDeviceClass = {
                        virtualDeviceId: virtualDevice.getData().id,
                        virtualDeviceName: virtualDevice.getName(),
                        deviceClass: virtualDevice.getClass()
                    };
                    result.push(myDeviceClass);
                });
            } catch (e) {
                this.error(e);
                throw e;
            }

            return result;
        });

        session.setHandler('set-device-classes', (data) => {
            this.log('set-device-class started:', data);

            try {
                data.list.forEach(device => {
                    let virtualDeviceId = device.virtualDeviceId;
                    let newDeviceClass = device.deviceClass;

                    // Get virtual device
                    let virtualDevice = this.getDevices().filter(virtualDevice => virtualDevice.getData().id === virtualDeviceId)[0];

                    // Modify the class
                    if (virtualDevice.getClass() !== newDeviceClass) {
                        virtualDevice.setClass(newDeviceClass);
                    }
                });
            } catch (e) {
                this.log(e);
                throw e;
            }
        });

        /**
         * DRIVER v2
         */

        /**
         * Delete device ?
          for (const device of Object.values(devices)) {
            if (device.zone != zombieZone.id)
              continue;
            if (device.class == "light") {
              await fetch('http://127.0.0.1/api/manager/devices/device/' + device.id, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json', 'Authorization' : "Bearer <token>"},
                body: JSON.stringify({ 'class': 'other' })
              });
            }
          }
        */


        /**
         * Get the initial_configuration
         * 
         * return: refer to pair/readme.md
         */
        session.setHandler('get-configuration', async () => {
            this.log('get-configuration started');

            let listVirtualDevices = [];
            let listPhysicalDevices = [];

            try {
                // Loop on all virtual devices
                for (const virtualDevice of this.getDevices()) {
                    this.log('Processing device:', virtualDevice);

                    let tmpVirtualDevice = {
                        'virtualDeviceId': virtualDevice.getId(),
                        'internalDeviceId': virtualDevice.getData().id, // Only used post creation of a new virtual device
                        'initial': {
                            name: virtualDevice.getName(),
                            zoneId: await this.getDeviceZone(virtualDevice),
                            class: virtualDevice.getClass(),
                            status: 'unmodified',
                            capabilities: []
                        },
                        'current': null
                    };

                    // Capabilities are: <capabilityType>[.<index>]
                    let capabilityKeysV2 = virtualDevice.getStoreValue('capabilityKeysV2');
                    // Maybe there are no capabilities
                    if (capabilityKeysV2 !== null) {
                        virtualDevice.getCapabilities().forEach(capability => {
                            let capabilityValueV2 = capabilityKeysV2[capability];
                            this.log('capabilityValueV2:', capabilityValueV2);
                            let tmpCapability = {
                                capabilityId: capability,
                                type: capability.split(".")[0],
                                index: capability.split(".").length > 1 ? capability.split(".")[1] : '1',
                                status: 'unmodified',
                                options: virtualDevice.getCapabilityOptions(capability),
                                physicalDeviceId: capabilityValueV2.physicalDeviceId,
                                nativeCapabilityId: capabilityValueV2.nativeCapabilityId
                            };

                            tmpVirtualDevice.initial.capabilities.push(tmpCapability);
                        });
                    }

                    tmpVirtualDevice.current = tmpVirtualDevice.initial;

                    listVirtualDevices.push(tmpVirtualDevice);
                }

                // Retrieve driver settings
                let conf = this.getConf();
                conf.forEach(physicalDevice => {
                    let realPhysicalDevice = PhysicalDeviceManager.getById(physicalDevice.physicalDeviceId);

                    let tmpPhysicalDevice = {
                        physicalDeviceId: physicalDevice.physicalDeviceId,
                        status: realPhysicalDevice.available === true ? 'available' : 'unavailable',
                        used: this.getDevices().filter(virtualDevice => virtualDevice.getStoreValue('capabilityKeysV2') === null ? 0 : Object.values(virtualDevice.getStoreValue('capabilityKeysV2')).filter(capabilityKeyV2 => capabilityKeyV2.physicalDeviceId === physicalDevice.physicalDeviceId).length > 0).length > 0,
                        name: physicalDevice.name,
                        ipAddress: physicalDevice.ipAddress,
                        port: physicalDevice.port,
                        encryptionKey: physicalDevice.encryptionKey,
                        password: physicalDevice.password,
                        nativeCapabilities: []
                    };

                    Object.values(realPhysicalDevice.nativeCapabilities).forEach(nativeCapability => {
                        // The same capability can be used several times on the same virtual device!
                        // We cannot use a simple filter on the virtual device list
                        let countUsed = 0;
                        this.getDevices().forEach(virtualDevice => {
                            countUsed += virtualDevice.getStoreValue('capabilityKeysV2') === null ? 0 : Object.values(virtualDevice.getStoreValue('capabilityKeysV2')).filter(capabilityKeysV2 => capabilityKeysV2.nativeCapabilityId === nativeCapability.getId()).length;
                        });

                        tmpPhysicalDevice.nativeCapabilities.push({
                            nativeCapabilityId: nativeCapability.getId(),
                            entityId: nativeCapability.entityId,
                            attribut: nativeCapability.attribut,
                            entityName: nativeCapability.entityName,
                            type: nativeCapability.type,
                            used: countUsed,
                            value: nativeCapability.value,
                            configs: nativeCapability.configs,
                            constraints: nativeCapability.constraints,
                            specialCase: nativeCapability.specialCase
                        });
                    });

                    listPhysicalDevices.push(tmpPhysicalDevice);
                });
            } catch (e) {
                this.error(e);
                throw e;
            }

            let result = {
                'listVirtualDevices': listVirtualDevices,
                'listPhysicalDevices': listPhysicalDevices,
                'listZones': await this.getAllZones()
            };

            this.log('result:', result);

            return result;
        });

        session.setHandler('modify-physical-device', (data) => {
            this.log('modify-physical-device:', data);

            try {
                let conf = this.getConf();
                let physicalDeviceConf = conf.find((physicalDevice) => physicalDevice.physicalDeviceId === data.physicalDeviceId);

                if (physicalDeviceConf === undefined) {
                    throw new Error('Cannot find physical device');
                }

                physicalDeviceConf.name = data.name;
                physicalDeviceConf.ipAddress = data.ipAddress;
                physicalDeviceConf.port = data.port;
                physicalDeviceConf.encryptionKey = data.encryptionKey;
                physicalDeviceConf.password = data.password;

                this.setConf(conf);

                let physicalDevice = PhysicalDeviceManager.getById(physicalDeviceConf.physicalDeviceId);
                PhysicalDeviceManager._delete(physicalDevice);
                PhysicalDeviceManager.create(true, physicalDeviceConf.physicalDeviceId, physicalDeviceConf.name, physicalDeviceConf.ipAddress, physicalDeviceConf.port, physicalDeviceConf.encryptionKey, physicalDeviceConf.password);
            } catch (e) {
                this.log(e);
                throw e;
            }
        });

        session.setHandler('connect-new-device', (data) => {
            this.log('connect-new-device:', data);

            try {
                // Check if physical device already exist
                let existingPhysicalDevice = PhysicalDeviceManager.get(data.ipAddress, data.port);
                if (existingPhysicalDevice) {
                    // Maybe it's a physical device without virtual device linked? In such case we can clean up
                    // Why? PairSession can end without notice, and so the physicalDevice created previosuly may not be cleaned up
                    PhysicalDeviceManager.checkDelete(null, existingPhysicalDevice);
                    existingPhysicalDevice = null;

                    // Let's check again
                    if (PhysicalDeviceManager.get(data.ipAddress, data.port)) {
                        session.emit('new-device-failed', 'A physical device already exist')
                            .catch(e => {
                                // Session expired, just ignore it
                                this.error('Failed to connect with device before pair session expired:', data);
                            });
                        return;
                    }
                }

                // Create a new physical device and add listeners
                PhysicalDeviceManager.create(false, data.physicalDeviceId, data.name, data.ipAddress, data.port, data.encryptionKey, data.password);

                PhysicalDeviceManager.getById(data.physicalDeviceId).on('available', async () => {
                    this.log('Received available event');

                    // Just wait 5 seconds to ensure we can retrieve some current values
                    setTimeout(() => {
                        let realPhysicalDevice = PhysicalDeviceManager.getById(data.physicalDeviceId);

                        let tmpPhysicalDevice = {
                            'physicalDeviceId': data.physicalDeviceId,
                            status: 'new',
                            used: this.getDevices().filter(virtualDevice => Object.values(virtualDevice.getStoreValue('capabilityKeysV2')).filter(capabilityKeyV2 => capabilityKeyV2.physicalDeviceId === data.physicalDeviceId).length > 0).length > 0,
                            name: realPhysicalDevice.name,
                            ipAddress: data.ipAddress,
                            port: data.port,
                            encryptionKey: data.encryptionKey,
                            password: data.password,
                            nativeCapabilities: []
                        };

                        Object.values(realPhysicalDevice.nativeCapabilities).forEach(nativeCapability => {
                            // The same capability can be used several times on the same virtual device!
                            // We cannot use a simple filter on the virtual device list
                            let countUsed = 0;
                            this.getDevices().forEach(virtualDevice => {
                                countUsed += Object.values(virtualDevice.getStoreValue('capabilityKeysV2')).filter(capabilityKeysV2 => capabilityKeysV2.nativeCapabilityId === nativeCapability.getId()).length;
                            });

                            tmpPhysicalDevice.nativeCapabilities.push({
                                nativeCapabilityId: nativeCapability.getId(),
                                entityId: nativeCapability.entityId,
                                attribut: nativeCapability.attribut,
                                entityName: nativeCapability.entityName,
                                type: nativeCapability.type,
                                used: countUsed,
                                value: nativeCapability.value,
                                configs: nativeCapability.configs,
                                constraints: nativeCapability.constraints,
                                specialCase: nativeCapability.specialCase
                            });
                        });


                        session.emit('new-device-connected', tmpPhysicalDevice)
                            .catch(e => {
                                // Session expired, cleaning up
                                this.error('Connected to device, but the pair session expired:', data);
                            });
                        PhysicalDeviceManager.checkDelete(null, realPhysicalDevice);
                    }, 5000);
                });

                PhysicalDeviceManager.getById(data.physicalDeviceId).on('unavailable', () => {
                    this.error('Received unavailable event');

                    session.emit('new-device-failed', {
                        'physicalDeviceId': data.physicalDeviceId,
                        message: 'Could not connect to the device, or something went wrong'
                    }).catch(e => {
                        // Session expired, just ignore it
                    });
                    PhysicalDeviceManager.checkDelete(null, PhysicalDeviceManager.getById(data.physicalDeviceId));
                });
            } catch (e) {
                this.error(e);
                throw e;
            } finally {
                this.log('connect-new-device finished');
            }
        });

        session.setHandler('apply-virtual-device', async (data) => {
            this.log('apply-virtual-device:', data);

            let virtualDevice = data.virtualDevice;
            let action = data.action;

            try {
                if (action !== "edit") {
                    await this.createDevice(virtualDevice.virtualDeviceId, {
                        name: virtualDevice.name,
                        zoneId: virtualDevice.zoneId,
                        classId: virtualDevice.classId
                    });
                } else {
                    await this.updateDevice(virtualDevice.virtualDeviceId, {
                        name: virtualDevice.name,
                        zoneId: virtualDevice.zoneId,
                        classId: virtualDevice.classId
                    });
                }
            } catch (e) {
                this.error(e);
                throw e;
            } finally {
                this.log('apply-virtual-device finished');
            }
        });

        session.setHandler('apply-capability', async (data) => {
            this.log('apply-capability:', data);

            let virtualDeviceId = data.virtualDeviceId;
            let action = data.action;
            let capability = data.capability;

            try {
                let virtualDevice = this.getDevices().find(virtualDevice => virtualDevice.getId() === virtualDeviceId);
                if (virtualDevice === undefined) {
                    throw new Error("Cannot find virtualDevice:", virtualDeviceId);
                }

                if (action === 'edit' && capability.initialCapabilityId === capability.capabilityId) {
                    // Modification but capabilityId remains the same!
                    // For whatever reason, we cannot remove/add the capability, we need to modify it

                    // Modify the capabilityKeys (different pohysical device and/or native capability)
                    let capabilityKeysV2 = virtualDevice.getStoreValue('capabilityKeysV2');
                    capabilityKeysV2[capability.capabilityId] = {
                        physicalDeviceId: capability.physicalDeviceId,
                        nativeCapabilityId: capability.nativeCapabilityId
                    };
                    virtualDevice.setStoreValue('capabilityKeysV2', capabilityKeysV2)
                        .catch(e => { throw e; });

                    virtualDevice.setCapabilityOptions(capability.capabilityId, capability.options)
                        .catch(e => { throw e; });

                    // Just in case a physical device became useless
                    this.cleanUpPhysicalDevices();
                } else {
                    // Remove the old capability
                    if (action === "edit") {
                        // Remove capabilityKeys first
                        let capabilityKeysV2 = virtualDevice.getStoreValue('capabilityKeysV2');
                        delete capabilityKeysV2[capability.initialCapabilityId];
                        virtualDevice.setStoreValue('capabilityKeysV2', capabilityKeysV2)
                            .catch(e => { throw e; });

                        // Remove capability
                        virtualDevice.removeCapability(capability.initialCapabilityId)
                            .catch(e => { throw e; });

                        // Remove the capability listener
                        virtualDevice._removeCapabilityListener(capability.initialCapabilityId);
                    }

                    // Add the new capability
                    virtualDevice.addCapability(capability.capabilityId)
                        .catch(e => { throw e; });
                    virtualDevice.setCapabilityOptions(capability.capabilityId, capability.options)
                        .catch(e => { throw e; });

                    // Add the capabilityKeys
                    let capabilityKeysV2 = virtualDevice.getStoreValue('capabilityKeysV2');
                    capabilityKeysV2[capability.capabilityId] = {
                        physicalDeviceId: capability.physicalDeviceId,
                        nativeCapabilityId: capability.nativeCapabilityId
                    };
                    virtualDevice.setStoreValue('capabilityKeysV2', capabilityKeysV2)
                        .catch(e => { throw e; });

                    // Add capability listener
                    virtualDevice._addCapabilityListener(capability.capabilityId);
                }
            } catch (e) {
                this.error(e);
                throw e;
            } finally {
                this.log('apply-capability finished');
            }
        });
    }


    /***********************
     * Check migration from wizard v1 to v2
     ***********************/
    checkMigration() {
        // If confStore is empty and it exists at least one virtual device, then we need to migrate
        if (this.getConf() !== null || this.getDevices().length === 0) {
            return;
        }

        // Need to migration
        let conf = [];
        let physicalDeviceIndex = 1;

        this.getDevices().forEach(virtualDevice => {
            // Get physical device settings
            let settings = virtualDevice.getSettings();
            let ipAddress = settings.ipAddress;
            let port = settings.port;
            let encryptionKey = settings.encryptionKey;
            let password = settings.password;

            // Make a new identifier for this physical device
            let physicalDeviceId = 'migrated' + physicalDeviceIndex;
            ++physicalDeviceIndex;

            // Add the physical device to the conf
            conf.push({
                'physicalDeviceId': physicalDeviceId,
                'name': physicalDeviceId,
                'ipAddress': ipAddress,
                'port': port,
                'encryptionKey': encryptionKey,
                'password': password
            });

            // Migrate the capabilityKeys
            let capabilityKeysV1 = virtualDevice.getStoreValue('capabilityKeys');

            // Maybe it doesn't have any capabilities
            if (capabilityKeysV1 !== null) {
                let capabilityKeysV2 = {};
                Object.keys(capabilityKeysV1).forEach(capabilityKey => {
                    if (virtualDevice.getCapabilities().includes(capabilityKey)) {

                        capabilityKeysV2[capabilityKey] = {
                            physicalDeviceId: physicalDeviceId,
                            nativeCapabilityId: capabilityKeysV1[capabilityKey]
                        }
                    }
                });
                virtualDevice.setStoreValue('capabilityKeysV2', capabilityKeysV2);
            } else {
                // no capabilities => no physical devices!
                return;
            }

            // Finaly store the new conf
            this.setConf(conf);
        });
    }

    /***********************
     * CONF functions
     * Current version: V2
     ***********************/

    /**
     * conf structure:
     *  [
     *      {
     *          physicalDeviceId: string Unique physical device identifier
     *          name: string Pretty name
     *          ipAddress: string
     *          port: string
     *          encryptionKey: string (nullable)
     *          password: string (nullable)
     *      }
     *  ]
     */

    /**
     * This function is used during test of the new driver
     * It resets the conf store to null, and next restart of the driver (of the app) will migrate it again
     */
    resetConf() {
        this.homey.settings.unset('listPhysicalDevicesV2');
    }

    /**
     * This function init the conf is it doesn't exist
     */
    initConf() {
        let conf = this.getConf();

        if (conf === null) {
            this.setConf([]);
        }
    }

    getConf() {
        return this.homey.settings.get('listPhysicalDevicesV2');
    }

    setConf(conf) {
        this.homey.settings.set('listPhysicalDevicesV2', conf);
    }


    /***********************
     * HomeyAPI functions
     ***********************/

    async initHomeyApi() {
        if (this.homeyApi === null) {
            this.homeyApi = await HomeyAPI.createLocalAPI({
                address: "http://127.0.0.1",
                token: "0572acf2-78ca-46bc-b25c-51289986f636:2886d20f-ed23-4fc2-8e81-a38e8bf780be:e8a223ceaba436028eb4a0f1316b35ab4b748f14"
            });

            /*this.homeyApi = await HomeyAPI.createAppAPI({
                homey: this.homey
            });
            */
        }
    }

    async createDevice(data) {
        this.log('createDevice:', ...arguments);

        try {
            // TODO: Works or not?
            let result = await this.homeyApi.drivers.createPairSessionDevice({
                id: this.homeyApi.drivers.getPairSession().id,
                device: {
                    name: data.name,
                    zone: data.zoneId,
                    class: data.classId
                }
            });

            this.log('createDevice result:', result);
        } catch (e) {
            throw e;
        }
    }

    async updateDevice(virtualDeviceId, data) {
        this.log('updateDevice:', ...arguments);

        try {
            // Need to retrieve the homey id of the device
            let realDevice = this.getDevices().find(device => device.getId() === virtualDeviceId);
            if (realDevice === undefined) {
                throw new Error('Could not find the device to delete:', virtualDeviceId);
            }

            if (data.name !== realDevice.getName() || data.zoneId !== realDevice.getZone()) {
                await this.homeyApi.devices.updateDevice({
                    id: realDevice.getId(),
                    device: {
                        name: data.name,
                        zone: data.zoneId
                    }
                });
            }

            if (data.classId !== realDevice.getClass()) {
                realDevice.setClass(data.classId);
            }
        } catch (e) {
            throw e;
        }
    }

    async deleteDevice(virtualDeviceId) {
        this.log('deleteDevice:', ...arguments);

        try {
            // Need to retrieve the homey id of the device
            let realDevice = this.getDevices().find(device => device.getId() === virtualDeviceId);
            if (realDevice === undefined) {
                throw new Error('Could not find the device to delete:', virtualDeviceId);
            }

            await this.homeyApi.devices.deleteDevice({
                id: realDevice.getId()
            });
        } catch (e) {
            throw e;
        }
    }

    async getDeviceZone(device) {
        this.log('getDeviceZone:', ...arguments);

        try {
            let apiDevice = await this.homeyApi.devices.getDevice({
                id: device.getId()
            });
            let apiZone = await apiDevice.getZone();
            let zoneId = apiZone.id;
            this.log('zoneName:', zoneId);
            return zoneId;
        } catch (e) {
            throw e;
        }
    }

    async getAllZones() {
        this.log('getAllZones');

        try {
            let zones = [];
            for (const zone of Object.values(await this.homeyApi.zones.getZones())) {
                this.log('processing zone:', zone);
                zones.push({
                    zoneId: zone.id,
                    name: zone.name,
                    parent: zone.parent,
                    order: zone.order
                });
            }
            this.log('zones:', zones);
            return zones;
        } catch (e) {
            throw e;
        }
    }

}

module.exports = Driver;
