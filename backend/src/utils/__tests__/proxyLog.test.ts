import { parseProxyLog } from '../proxyLog';

const T = 'container,info,debug';
const ok = `3proxy-17: {"time_unix":1790665930, "proxy":{"type":"PROXY", "port":3128}, "error":{"code":"00000"}, "auth":{"user":"stylebnm@123"}, "client":{"ip":"104.28.237.72", "port":35542}, "server":{"ip":"163.181.201.192", "port":443}, "bytes":{"sent":1630, "received":4511}, "request":{"hostname":"mall-i10.xhscdn.com"}, "message":"CONNECT mall-i10.xhscdn.com:443 HTTP/1.1"}`;
const denied = `3proxy-18: {"time_unix":1790665937, "proxy":{"type":"PROXY", "port":3128}, "error":{"code":"00100"}, "auth":{"user":"-"}, "client":{"ip":"104.28.237.72", "port":65442}, "server":{"ip":"0.0.0.0", "port":0}, "bytes":{"sent":0, "received":0}, "request":{"hostname":"status-ipv6.jpush.cn"}, "message":"CONNECT status-ipv6.jpush.cn:443 HTTP/1.1"}`;
const socks = `3proxy-20: {"time_unix":1790665779, "proxy":{"type":"SOCKS", "port":1080}, "error":{"code":"00401"}, "auth":{"user":"-"}, "client":{"ip":"156.225.1.90", "port":44146}, "server":{"ip":"0.0.0.0", "port":0}, "bytes":{"sent":0, "received":0}, "request":{"hostname":"[0.0.0.0]"}, "message":"UNKNOWN 0.0.0.0:0"}`;

describe('parseProxyLog', () => {
  it('parses a successful request', () => {
    const r = parseProxyLog(T, ok)!;
    expect(r).toMatchObject({
      source: '3proxy', proxyType: 'PROXY', proxyPort: 3128, clientIp: '104.28.237.72',
      serverIp: '163.181.201.192', serverPort: 443, authUser: 'stylebnm@123',
      hostname: 'mall-i10.xhscdn.com', method: 'CONNECT', bytesSent: 1630, bytesReceived: 4511,
      status: 'ok',
    });
    expect(r.eventTime.getTime()).toBe(1790665930 * 1000);
  });

  it('marks unauthenticated attempts with no server as denied', () => {
    const r = parseProxyLog(T, denied)!;
    expect(r.status).toBe('denied');
    expect(r.authUser).toBeNull();
    expect(r.serverIp).toBeNull();
  });

  it('parses SOCKS and drops the placeholder hostname', () => {
    const r = parseProxyLog(T, socks)!;
    expect(r).toMatchObject({ proxyType: 'SOCKS', proxyPort: 1080, status: 'denied', hostname: null });
  });

  it('does not depend on the container name', () => {
    expect(parseProxyLog(T, ok.replace('3proxy-17', 'my-proxy'))!.source).toBe('my-proxy');
    expect(parseProxyLog(T, ok.replace('3proxy-17', 'squid'))!.source).toBe('squid');
  });

  it('strips worker suffixes like -b-32 from the source', () => {
    expect(parseProxyLog(T, ok.replace('3proxy-17', '3proxy-b-32'))!.source).toBe('3proxy');
  });

  it('accepts bare JSON and a JSON shape without proxy.type', () => {
    const bare = ok.slice(ok.indexOf('{'));
    expect(parseProxyLog(T, bare)!.source).toBe('proxy');
    expect(parseProxyLog(T, 'x: {"time_unix":1790665930,"client":{"ip":"1.2.3.4"}}')!.proxyType).toBe('UNKNOWN');
  });

  it('requires the container,info,debug topics in any order', () => {
    expect(parseProxyLog('debug,info,container', ok)).not.toBeNull();
    expect(parseProxyLog('container,info', ok)).toBeNull();
  });

  it('ignores non-container topics, non-JSON, malformed JSON and other JSON shapes', () => {
    expect(parseProxyLog('system,info', ok)).toBeNull();
    expect(parseProxyLog(T, 'hello: world')).toBeNull();
    expect(parseProxyLog(T, 'x: {"client":')).toBeNull();
    expect(parseProxyLog(T, 'app: {"level":"info","msg":"hi"}')).toBeNull();
    expect(parseProxyLog(T, null)).toBeNull();
  });
});
