const NewPhysicalDevicePage = function () {
  return {
    componentName: "new-physical-device-page",
    $template: "#template-new-physical-device-page",

    name: null,
    ipAddress: null,
    port: null,
    encryptionKey: null,
    password: null,

    _newPhysicalDeviceId: null,
    _newPhysicalDeviceTimeout: null,

    _initValues: null,
    _modified: null,

    mounted() {
      wizardlog('[' + this.componentName + '] ' + 'mounted');

      pageHandler.registerComponent(this.componentName, this);
      Homey.on('new-device-connected', data => { this._applyConnected(data); });
      Homey.on('new-device-failed', data => { this._applyFailed(data); });
    },
    async init() {
      wizardlog('[' + this.componentName + '] ' + 'init');

      this._initValues = {};
      this.name = this._initValues.name = "";
      this.ipAddress = this._initValues.ipAddress = "";
      this.port = this._initValues.port = "6053";
      this.encryptionKey = this._initValues.encryptionKey = "";
      this.password = this._initValues.password = "";

      this._newPhysicalDeviceId = null;

      await PetiteVue.nextTick();
      this.checkValidity();
    },
    checkValidity() {
      wizardlog('[' + this.componentName + '] ' + 'checkValidity');

      // Reset error and warning messsages
      errorAndWarningList.reset();

      // Retrieve elements from refs
      const nameElt = this.$refs.name;
      const ipAddressElt = this.$refs.ipAddress;
      const portElt = this.$refs.port;
      const encryptionKeyElt = this.$refs.encryptionKey;
      const passwordElt = this.$refs.password;

      // Reset custom validity
      nameElt.setCustomValidity('');
      ipAddressElt.setCustomValidity('');
      portElt.setCustomValidity('');
      encryptionKeyElt.setCustomValidity('');
      passwordElt.setCustomValidity('');

      // Name format
      if (!nameElt.validity.valid) {
        errorAndWarningList.addError("wizard2.new-physical-device.error-name");
      }

      // Name must be unique
      if (nameElt.validity.valid) {
        let tmp = configuration.physicalDevices.find(e => e.name === this.name);
        if (tmp !== undefined) {
          nameElt.setCustomValidity(false);
          errorAndWarningList.addError("wizard2.new-physical-device.error-name-already-used");
        }
      }

      // IP Address format
      if (!ipAddressElt.validity.valid) {
        errorAndWarningList.addError("wizard2.new-physical-device.error-ip-address");
      }

      // Port format
      if (!portElt.validity.valid) {
        errorAndWarningList.addError("wizard2.new-physical-device.error-port");
      }

      // IP Address and port must be unique
      if (ipAddressElt.validity.valid && portElt.validity.valid) {
        let tmp = configuration.physicalDevices.find(e => e.ipAddress === this.ipAddress && e.port === this.port);
        if (tmp !== undefined) {
          ipAddressElt.setCustomValidity(false);
          portElt.setCustomValidity(false);
          errorAndWarningList.addError("wizard2.new-physical-device.error-ipAddress-and-port-already-used");
        }
      }

      // Encryption key format
      if (encryptionKeyElt.validity.patternMismatch) {
        errorAndWarningList.addError("wizard2.new-physical-device.error-encryption-key");
      } else if (this.encryptionKey !== '' && atob(this.encryptionKey).length !== 32) {
        encryptionKeyElt.setCustomValidity(false);
        errorAndWarningList.addError("wizard2.new-physical-device.error-encryption-key");
      }

      // encryptionKey and password are exclusive
      if (this.encryptionKey !== '' && this.password !== '') {
        encryptionKeyElt.setCustomValidity(false);
        passwordElt.setCustomValidity(false);
        errorAndWarningList.addError("wizard2.new-physical-device.error-encryption-key-and-password-are-exclusive");
      }

      // Encryption key recommended (need to check last)
      if (encryptionKeyElt.validity.valid && this.encryptionKey === '') {
        errorAndWarningList.addWarning("wizard2.new-physical-device.warning-encryption-key-recommended");
      }

      this.checkModified();
    },
    checkModified() {
      wizardlog('[' + this.componentName + '] ' + 'checkModified');

      this._modified = Object.keys(this._initValues).find(key => this._initValues[key] !== this[key]) !== undefined;
    },
    async back() {
      wizardlog('[' + this.componentName + '] ' + 'back');

      this._modified ? (await confirm(Homey.__("wizard2.new-physical-device.loseModification", "warning")) ? pageHandler.setPage('list-virtual-devices-page') : true) : pageHandler.setPage('list-virtual-devices-page');
    },
    async apply() {
      wizardlog('[' + this.componentName + '] ' + 'apply');

      Homey.showLoadingOverlay();

      try {
        this._newPhysicalDeviceId = 'Wizard' + Date.now();

        await Homey.emit('connect-new-device', {
          physicalDeviceId: this._newPhysicalDeviceId,
          name: this.name,
          ipAddress: this.ipAddress,
          port: this.port,
          encryptionKey: this.encryptionKey,
          password: this.password
        }).catch(e => { throw e; });

        // We wait 15 seconds maximum
        this._timeout = setTimeout(this._applyTimeout, 15000);
      } catch (e) {
        this._newPhysicalDeviceId = null;
        if (this._timeout !== null) {
          clearTimeout(this._newPhysicalDeviceTimeout);
          this._timeout = null;
        }
        wizardlog(e);

        Homey.hideLoadingOverlay();
        alert(Homey.__("wizard2.new-physical-device.fatal-error", "error"));
      }
    },
    _applyTimeout() {
      wizardlog('[' + this.componentName + '] ' + '_applyTimeout');
      this._timeout = null;
      this._newPhysicalDeviceId = null;

      Homey.hideLoadingOverlay();
      alert(Homey.__("wizard2.new-physical-device.timeout", "error"));
    },
    _applyConnected(newPhysicalDevice) {
      wizardlog('[' + this.componentName + '] ' + '_applyConnected: ', ...arguments);

      if (newPhysicalDevice.physicalDeviceId !== this._newPhysicalDeviceId) {
        wizardlog('[' + this.componentName + '] ' + 'Unexpected new physical device, ignoring');
        return;
      }

      // Cancel the timeout
      if (this._timeout !== null) {
        clearTimeout(this._timeout);
        this._timeout = null;
      }

      configuration.addNewPhysicalDevice(newPhysicalDevice);
      this._newPhysicalDeviceId = null;

      pageHandler.setPage("list-virtual-devices-page");
    },
    _applyFailed(data) {
      wizardlog('[' + this.componentName + '] ' + '_applyFailed: ', ...arguments);

      if (data.physicalDeviceId !== this._newPhysicalDeviceId) {
        wizardlog('[' + this.componentName + '] ' + 'Unexpected new physical device failure, ignoring');
        return;
      }

      // Cancel the timeout
      if (this._timeout !== null) {
        clearTimeout(this._timeout);
        this._timeout = null;
      }

      this._newPhysicalDeviceId = null;

      Homey.hideLoadingOverlay();
      alert(Homey.__("wizard2.new-physical-device.failed") + ": " + data.message, "error");
    }
  };
};


