import test from 'node:test';
import assert from 'node:assert/strict';
import {publicAddress,validatedAddress} from '../lib/calendar/callback-policy.ts';
test('callback IP policy rejects non-public, mapped and transition addresses',()=>{
 for(const value of ['0.0.0.0','10.1.2.3','127.0.0.1','169.254.169.254','172.16.0.1','192.168.0.1','100.64.0.1','192.0.2.1','198.18.0.1','198.51.100.1','203.0.113.1','224.0.0.1','255.255.255.255','::','::1','::ffff:8.8.8.8','fe80::1','fc00::1','2001:db8::1','2002:0808:0808::1','2001::1','3fff::1','not-an-ip'])assert.equal(publicAddress(value),false,value);
 for(const value of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111'])assert.equal(publicAddress(value),true,value);
});
test('all DNS answers are checked and only the chosen literal IP is returned',()=>{
 assert.equal(validatedAddress(['8.8.8.8','1.1.1.1']),'8.8.8.8');
 for(const values of [[],['8.8.8.8','127.0.0.1'],Array(33).fill('8.8.8.8')])assert.throws(()=>validatedAddress(values),/unsafe_destination/);
 // Each new connection calls validation again; no hostname is passed onward.
 assert.throws(()=>validatedAddress(['127.0.0.1']),/unsafe_destination/);
 for(const value of ['134744072','0x08080808','010.010.010.010','8.8.2056','8.8','2606:4700:4700::1111%eth0'])assert.equal(publicAddress(value),false,value);
});
