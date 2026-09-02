const UAT_3DSS_CONFIG = Object.freeze({
  paramId: "EMV3DS",
  startVersion: "1.0",
  endVersion: "2.2.0",
  referenceNumber: "3DS_LOA_SER_CASB_020301_00986",
  proxyServer: "192.168.15.201",
  proxyPort: 3128,
  requestorUrl: "https://uatczsecure.bob.bt/3dss/rreq",
  rreqUrl: "https://uatczsecure.bob.bt/3dss/rreq",
  cresUrl: "https://uatczsecure.bob.bt/3dss/cresp",
  acsCommunicationTimeoutSeconds: 10,
  dsCommunicationTimeoutSeconds: 10,
  acquirerHostCommunicationTimeoutSeconds: 10,
  notificationUrl: "https://uatczsecure.bob.bt/3dss/notifyReq",
  mkReqUrl: "https://uatczsecure.bob.bt/3dss/mkReq",
  mercReqUrl: "https://uatczsecure.bob.bt/3dss/mercReq"
});

module.exports = {
  UAT_3DSS_CONFIG
};
