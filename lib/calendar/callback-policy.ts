import ipaddr from 'ipaddr.js';
export function publicAddress(value: string): boolean {
 try {
  const ip=ipaddr.parse(value);
  if(ip.range()!=='unicast')return false;
  if(ip.kind()==='ipv6')return ip.match(ipaddr.parseCIDR('2000::/3'))&&!['2001::/23','2002::/16','3fff::/20'].some(cidr=>ip.match(ipaddr.parseCIDR(cidr)));
  return true;
 }catch{return false;}
}
export function validatedAddress(addresses: string[]): string {
 if(!addresses.length||addresses.length>32||addresses.some(ip=>!publicAddress(ip)))throw new Error('unsafe_destination');
 return addresses[0];
}
