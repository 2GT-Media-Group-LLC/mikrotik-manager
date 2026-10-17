import { signV4, uriEncode } from '../s3';

describe('S3 SigV4', () => {
  it('matches AWS’s published GET Object example', () => {
    // https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
    const h = signV4({
      method: 'GET', host: 'examplebucket.s3.amazonaws.com', path: '/test.txt',
      headers: { range: 'bytes=0-9' },
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      region: 'us-east-1', accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      now: new Date('2013-05-24T00:00:00Z'),
    });
    expect(h.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, '
      + 'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, '
      + 'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  });

  it('matches AWS’s published GET Bucket (list) example, with a query', () => {
    const h = signV4({
      method: 'GET', host: 'examplebucket.s3.amazonaws.com', path: '/', query: { 'max-keys': '2', prefix: 'J' },
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      region: 'us-east-1', accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      now: new Date('2013-05-24T00:00:00Z'),
    });
    expect(h.authorization).toContain('Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7');
  });

  it('encodes keys the way SigV4 expects', () => {
    expect(uriEncode('mtm/backup 1(a).mtmbackup', true)).toBe('mtm/backup%201%28a%29.mtmbackup');
    expect(uriEncode('a/b')).toBe('a%2Fb');
  });
});
