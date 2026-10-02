import { translateToWifiParams } from '../wifiParams';

describe('translateToWifiParams (C6)', () => {
  it('maps regulatory and power fields instead of dropping them', () => {
    expect(translateToWifiParams({ country: 'United States', 'tx-power': '17', 'antenna-gain': '3', installation: 'indoor' }))
      .toEqual({
        'configuration.country': 'United States',
        'configuration.tx-power': '17',
        'configuration.antenna-gain': '3',
        'configuration.installation': 'indoor',
      });
  });

  it('maps legacy ciphers and management protection', () => {
    expect(translateToWifiParams({ 'unicast-ciphers': 'aes-ccm,tkip', 'group-ciphers': 'aes-ccm', 'management-protection': 'allowed' }))
      .toEqual({ 'security.encryption': 'ccmp,tkip', 'security.group-encryption': 'ccmp', 'security.management-protection': 'allowed' });
  });

  it('refuses what has no wifi-package equivalent', () => {
    expect(() => translateToWifiParams({ 'tx-power-mode': 'all-rates-fixed' })).toThrow(/tx-power-mode/);
    expect(() => translateToWifiParams({ 'unicast-ciphers': 'wep' })).toThrow(/wep/);
    expect(translateToWifiParams({ 'tx-power-mode': 'default' })).toEqual({});
  });

  it('sends one passphrase when both WPA keys are given', () => {
    expect(translateToWifiParams({ 'wpa-pre-shared-key': 'x', 'wpa2-pre-shared-key': 'y' })).toEqual({ 'security.passphrase': 'y' });
    expect(translateToWifiParams({ 'wpa-pre-shared-key': 'x' })).toEqual({ 'security.passphrase': 'x' });
  });

  it('leaves mode off a virtual AP', () => {
    expect(translateToWifiParams({ mode: 'ap', 'master-interface': 'wifi1', ssid: 'g' }))
      .toEqual({ 'master-interface': 'wifi1', 'configuration.ssid': 'g' });
  });

  it('refuses keys that are not RouterOS properties', () => {
    expect(() => translateToWifiParams({ __proto__x: 'y' } as Record<string, string>)).toThrow(/wireless setting/);
    expect(() => translateToWifiParams(JSON.parse('{"__proto__":"y"}'))).toThrow(/wireless setting/);
  });
});
