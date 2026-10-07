import ipaddr from 'ipaddr.js';
export function publicAddress(value: string): boolean {
 try {
  if(value.includes('%'))return false;
  const ip=ipaddr.parse(value);
  // Reject shorthand/octal/hex IPv4 that a socket API might resolve as a name.
  if(ip.kind()==='ipv4'&&!ipaddr.IPv4.isValidFourPartDecimal(value))return false;
  if(ip.range()!=='unicast')return false;
  if(ip.kind()==='ipv6')return ip.match(ipaddr.parseCIDR('2000::/3'))&&!['2001::/23','2002::/16','3fff::/20'].some(cidr=>ip.match(ipaddr.parseCIDR(cidr)));
  return true;
 }catch{return false;}
}
export function validatedAddress(addresses: string[]): string {
 if(!addresses.length||addresses.length>32||addresses.some(ip=>!publicAddress(ip)))throw new Error('unsafe_destination');
 return addresses[0];
}
