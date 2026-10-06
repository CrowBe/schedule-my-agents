//go:build js && wasm

// TLS and X.509 are delegated to Go's standard library. JavaScript supplies only
// a byte stream connected to an already validated IP and a trusted root bundle.
package main

import (
 "bufio"
 "bytes"
 "crypto/tls"
 "crypto/x509"
 "errors"
 "io"
 "net"
 "net/http"
 "syscall/js"
 "time"
)

type result struct { value js.Value; err error }
func await(p js.Value) (js.Value,error) {
 ch:=make(chan result,1)
 ok:=js.FuncOf(func(_ js.Value,args []js.Value) any {ch<-result{value:args[0]};return nil})
 fail:=js.FuncOf(func(_ js.Value,args []js.Value) any {ch<-result{err:errors.New("byte transport failed")};return nil})
 p.Call("then",ok).Call("catch",fail)
 r:=<-ch;ok.Release();fail.Release();return r.value,r.err
}
type stream struct { read,write,close js.Value; pending []byte; readBytes int }
func(s *stream) Read(p []byte)(int,error) {
 if len(s.pending)==0 {
  v,err:=await(s.read.Invoke());if err!=nil{return 0,err};if v.IsNull(){return 0,io.EOF}
  if v.Get("byteLength").Int()>65536{return 0,errors.New("oversized transport chunk")}
  s.readBytes+=v.Get("byteLength").Int();if s.readBytes>131072{return 0,errors.New("TLS response exceeds byte budget")};s.pending=make([]byte,v.Get("byteLength").Int());js.CopyBytesToGo(s.pending,v)
 }
 n:=copy(p,s.pending);s.pending=s.pending[n:];return n,nil
}
func(s *stream) Write(p []byte)(int,error) {
 v:=js.Global().Get("Uint8Array").New(len(p));js.CopyBytesToJS(v,p)
 _,err:=await(s.write.Invoke(v));if err!=nil{return 0,err};return len(p),nil
}
func(s *stream) Close()error{s.close.Invoke();return nil}
func(s *stream) LocalAddr()net.Addr{return addr("site")}
func(s *stream) RemoteAddr()net.Addr{return addr("validated-peer")}
func(s *stream) SetDeadline(time.Time)error{return nil} // JS must enforce the total deadline and close the stream.
func(s *stream) SetReadDeadline(time.Time)error{return nil}
func(s *stream) SetWriteDeadline(time.Time)error{return nil}
type addr string
func(a addr)Network()string{return "tcp"}
func(a addr)String()string{return string(a)}
func request(a []js.Value)([]byte,error) {
 host,rootsPEM:=a[0].String(),a[1].String()
 roots:=x509.NewCertPool();if !roots.AppendCertsFromPEM([]byte(rootsPEM)){return nil,errors.New("invalid root bundle")}
 s:=&stream{read:a[2],write:a[3],close:a[4]};defer s.Close()
 conn:=tls.Client(s,&tls.Config{ServerName:host,RootCAs:roots,MinVersion:tls.VersionTLS12,NextProtos:[]string{"http/1.1"}})
 if err:=conn.Handshake();err!=nil{return nil,err}
 // No application bytes are sent before full chain, hostname and validity checks.
 size:=a[5].Get("byteLength").Int();if size>270336{return nil,errors.New("request too large")};body:=make([]byte,size);js.CopyBytesToGo(body,a[5])
 if _,err:=io.Copy(conn,bytes.NewReader(body));err!=nil{return nil,err}
 resp,err:=http.ReadResponse(bufio.NewReaderSize(conn,4096),nil);if err!=nil{return nil,err};defer resp.Body.Close()
 // Delivery needs terminal HTTP statuses; legacy diagnostic callers still reject them.
 structured:=len(a)>6&&a[6].Bool()
 if !structured&&(resp.StatusCode<200||resp.StatusCode>=300){return nil,errors.New("non-success callback response")}
 if structured&&(resp.StatusCode<200||resp.StatusCode>=300){return []byte{byte(resp.StatusCode>>8),byte(resp.StatusCode)},nil}
 if resp.Header.Get("Content-Encoding")!=""&&resp.Header.Get("Content-Encoding")!="identity"{return nil,errors.New("unsupported response encoding")}
 data,err:=io.ReadAll(io.LimitReader(resp.Body,4097));if err!=nil{return nil,err};if len(data)>4096{return nil,errors.New("response too large")}
 if structured{return append([]byte{byte(resp.StatusCode>>8),byte(resp.StatusCode)},data...),nil}
 return data,nil
}
func main(){
 fn:=js.FuncOf(func(_ js.Value,a []js.Value)any{
  executor:=js.FuncOf(func(_ js.Value,p []js.Value)any{
   resolve,reject:=p[0],p[1]
   go func(){data,err:=request(a);if err!=nil{reject.Invoke(js.Global().Get("Error").New(err.Error()));return};v:=js.Global().Get("Uint8Array").New(len(data));js.CopyBytesToJS(v,data);resolve.Invoke(v)}()
   return nil
  })
  promise:=js.Global().Get("Promise").New(executor);executor.Release();return promise
 })
 js.Global().Set("siteTLSRequest",fn)
 select{}
}
