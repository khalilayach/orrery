/* shore.js - the night shore foreground (replaces the temple photo).
   A perspective ocean evaluated per pixel, wet sand and three palms, all pushed through the same ordered dither so they
   read as pixels. Drawn on a canvas covering the bottom 55% of the screen.
   Shore.init(canvas) once, Shore.resize() on resize, Shore.draw(tSeconds, still) every frame.
   The broad sky/horizon blend lives in the void shader (it thickens its own glyphs toward Shore.HZ); this file adds the
   matching haze on the far water and a short glow band above the horizon.

   Performance: everything that never moves (sand, wet band, headlands, horizon glow) is baked once per resize into `bg`.
   Per-pixel wave phases are baked into a table as sin/cos pairs, so a frame only needs angle-addition (multiplies) instead
   of ~12 trig calls per sea pixel. Palms are re-rendered only inside their own bounding boxes. */
(function(){
  "use strict";
  var P=2,TOPF=.45,HZ=.925;                       // pixel size (css px), canvas top as a fraction of height, horizon as a fraction of height
  function px(h){var n=parseInt(h.slice(1),16);return(255<<24)|((n&255)<<16)|((n>>8&255)<<8)|(n>>16&255)}
  var SEA=["#050f1e","#071629","#0a2038","#0f3050","#18506a","#2a7186","#5f9fa6","#dcebe8"].map(px);
  var SAND=["#0d0c16","#15141f","#1d1b2b","#292638","#363148","#443e54","#5a5368","#6f657d","#8c8294","#a89ba5"].map(px);
  var WETS=["#070d1a","#0b1626","#10202f","#18303f"].map(px);
  var ROCK=px("#060a18");
  var BY=new Float32Array([0,8,2,10,12,4,14,6,3,11,1,9,15,7,13,5].map(function(v){return(v+.5)/16}));
  function dz(v,x,y,n){var s=v<0?0:v*n;if(s>n-.001)s=n-.001;var f=s|0;return f+((s-f)>BY[((y&3)<<2)|(x&3)]?1:0)}
  function hs(x,y){var n=Math.sin(x*127.1+y*311.7)*43758.5453;return n-Math.floor(n)}
  function h2(a,b){var n=(Math.imul(a|0,374761393)+Math.imul(b|0,668265263))|0;n=Math.imul(n^(n>>>13),1274126177);return((n^(n>>>16))>>>0)/4294967296}
  function vnz(x,y){var xi=Math.floor(x),yi=Math.floor(y),xf=x-xi,yf=y-yi,a=h2(xi,yi),b=h2(xi+1,yi),c=h2(xi,yi+1),d=h2(xi+1,yi+1),u=xf*xf*(3-2*xf),v=yf*yf*(3-2*yf);return a+(b-a)*u+(c-a)*v+(a-b-c+d)*u*v}
  function sstep(a,b,x){var k=x<a?0:x>b?1:(x-a)/(b-a);return k*k*(3-2*k)}
  var WV=[[.2,1,.9,.8,.045],[-.5,1,1.7,1.1,.025],[.7,1,3.1,1.6,.012],[-.2,1,5.3,2.0,.006],[0,1,.5,.6,.07]].map(function(w){var l=Math.hypot(w[0],w[1]);return{kx:w[0]/l*w[2],kz:w[1]/l*w[2],w:w[3],A:w[4]}});
  var EXP=new Float32Array(256);for(var ei=0;ei<256;ei++)EXP[ei]=Math.exp(-ei/32);    // exp(-u) lookup for the sky reflection falloff

  /* palm: tapering ringed trunk, fronds with leaflets, coconuts, grass and rocks. Drawn smooth, dithered afterwards. */
  function palm(c,bx,by,h,lean,t,sc,body,rim,seed,F){
    var tx=bx+lean*h,ty=by-h,cx=bx+lean*h*.12,cy=by-h*.58,N=28,i,pass;
    function pt(s){var u=1-s;return[u*u*bx+2*u*s*cx+s*s*tx,u*u*by+2*u*s*cy+s*s*ty]}
    c.lineCap="butt";
    for(pass=0;pass<2;pass++)for(i=0;i<N;i++){var a=pt(i/N),b=pt((i+1)/N),w=(3.6-1.7*i/N)*sc,o=pass?0:-.9*sc;
      c.strokeStyle=pass?body:rim;c.lineWidth=w;c.beginPath();c.moveTo(a[0]+o,a[1]);c.lineTo(b[0]+o,b[1]);c.stroke()}
    c.strokeStyle=rim;c.globalAlpha=.4;c.lineWidth=.7;
    for(i=2;i<N;i+=2){var q=pt(i/N),ww=(3.6-1.7*i/N)*sc*.5;c.beginPath();c.moveTo(q[0]-ww,q[1]);c.lineTo(q[0]+ww,q[1]+.9);c.stroke()}
    c.globalAlpha=1;
    var L=h*.46;
    for(i=0;i<F;i++){
      var th=Math.PI*(.97-.94*i/(F-1)),dx=Math.cos(th),dy=-Math.sin(th),Li=L*(.78+.22*Math.sin(i*2.3+seed)),droop=.28+.55*Math.abs(dx),sway=Math.sin(t*.7+i*.9+seed)*Li*.035;
      var P0=[tx,ty],P1=[tx+dx*Li*.5,ty+dy*Li*.5-Li*.12],P2=[tx+dx*Li+sway,ty+dy*Li*.5+droop*Li];
      var at=function(s){var u=1-s;return[u*u*P0[0]+2*u*s*P1[0]+s*s*P2[0],u*u*P0[1]+2*u*s*P1[1]+s*s*P2[1]]};
      var M=17,upper=i>2&&i<F-3;
      for(pass=upper?0:1;pass<2;pass++){var off=pass?0:-.7*sc;c.strokeStyle=pass?body:rim;
        c.lineWidth=1.2*sc;c.beginPath();var s0=at(0);c.moveTo(s0[0]+off,s0[1]+off);for(var m=1;m<=M;m++){s0=at(m/M);c.lineTo(s0[0]+off,s0[1]+off)}c.stroke();
        c.lineWidth=.75*sc;
        for(m=2;m<=M;m++){var s=m/M,a2=at(s),b2=at(Math.min(1,s+.04)),ex=b2[0]-a2[0],ey=b2[1]-a2[1],tl=Math.hypot(ex,ey)||1,ux=ex/tl,uy=ey/tl,ll=Li*.3*(1-.6*s)*(.8+.2*Math.sin(m*3+i));
          for(var sd=-1;sd<=1;sd+=2){var ca=Math.cos(1.1*sd),sa=Math.sin(1.1*sd),vx=ux*ca-uy*sa,vy=ux*sa+uy*ca;vy+=.55;var vl=Math.hypot(vx,vy);vx/=vl;vy/=vl;
            c.beginPath();c.moveTo(a2[0]+off,a2[1]+off);c.lineTo(a2[0]+vx*ll+off,a2[1]+vy*ll+off);c.stroke()}}}}
    c.fillStyle=body;[[-1.6,2.6],[1.2,3.1],[.1,4]].forEach(function(n){c.beginPath();c.arc(tx+n[0]*sc,ty+n[1]*sc,1.7*sc,0,7);c.fill()});
    c.strokeStyle=rim;c.lineWidth=.6;c.beginPath();c.arc(tx-1.6*sc-.5,ty+2.6*sc-.5,1.7*sc,3.4,4.9);c.stroke();
    c.strokeStyle=body;c.lineWidth=.8;
    for(i=0;i<16;i++){var gx=bx+(h2(i,seed)-.5)*16*sc,gh=(2+h2(i,seed+3)*6)*sc,gs=Math.sin(t*1.1+i)*.8;c.beginPath();c.moveTo(gx,by+1);c.quadraticCurveTo(gx+gs,by-gh*.6,gx+gs*2+(h2(i,5)-.5)*2,by-gh);c.stroke()}
    c.fillStyle=body;[[-9,0,5],[8,1,4],[14,0,3]].forEach(function(r){c.beginPath();c.ellipse(bx+r[0]*sc,by+r[1],r[2]*sc,r[2]*sc*.55,0,0,7);c.fill()})
  }

  var cv,ctx,pc,pctx,PW=0,PH=0,img=null,b32=null,bg=null,last=-1,tick=0,dirty=true;
  var T=null,STR=20,NR=0,y0=0,hzp=0,FH=0,GH=0,dS0=0,rowFar,rowSl,rowHaze,rowWob,rowKeep,ex,glints=[],gN=0,palmIdx=null,palmCol=null,palmN=0;
  var S={ready:false,HZ:HZ,TOPF:TOPF};

  S.init=function(canvas){cv=canvas;ctx=cv.getContext("2d");pc=document.createElement("canvas");pctx=pc.getContext("2d",{willReadFrequently:true});S.ready=true;S.resize(true)};
  var rt=0;                                          // a window drag fires resize constantly and the bake costs ~0.2s: wait for it to settle
  function doResize(){PW=Math.ceil(innerWidth/P);PH=Math.ceil(innerHeight*(1-TOPF)/P);cv.width=PW;cv.height=PH;pc.width=PW;pc.height=PH;img=null;bake();dirty=true;last=-1}
  S.resize=function(now){if(!S.ready)return;clearTimeout(rt);if(now===true||!bg)doResize();else rt=setTimeout(doResize,140)};

  /* ---- static layer: horizon glow, headlands, sand + damp band + shells/pebbles/glints; and the per-pixel sea tables ---- */
  function bake(){
    var x,y,r,k,i,o,d,u;
    FH=innerHeight/P;hzp=(HZ-TOPF)*innerHeight/P;GH=PH-hzp;dS0=GH*.5;
    var f=FH*.85,cx=PW/2,dSmax=dS0+GH*.03+.3+2.4+3.4;
    y0=Math.floor(hzp)+1;NR=Math.max(0,Math.min(PH-y0,Math.ceil(dSmax)+1));
    bg=new Uint32Array(PW*PH);glints=[];ex=new Float32Array(PW);
    // headlands + a dithered glow band that thickens toward the horizon (continues the void's own haze)
    for(x=0;x<PW;x++){u=x/PW;var isl=FH*.045*Math.exp(-Math.pow((u-.1)/.09,2))+FH*.017*Math.exp(-Math.pow((u-.55)/.05,2));
      for(y=Math.max(0,Math.floor(hzp-isl));y<hzp&&y<PH;y++)bg[y*PW+x]=ROCK;
}
    rowFar=new Float32Array(NR);rowSl=new Float32Array(NR);rowHaze=new Float32Array(NR);rowWob=new Float32Array(NR);rowKeep=new Float32Array(NR);
    T=new Float32Array(NR*PW*STR);
    for(r=0;r<NR;r++){y=y0+r;d=y-hzp;var zw=f/d;
      rowSl[r]=1/(1+zw*.05);rowFar[r]=sstep(FH*.01,FH*.07,d);rowHaze[r]=(1-sstep(0,FH*.11,d))*.06;rowWob[r]=Math.sin(y*.3)*.3;rowKeep[r]=.22+.78*sstep(0,FH*.07,d);
      for(x=0;x<PW;x++){var xw=(x-cx)/d;o=(r*PW+x)*STR;
        for(k=0;k<5;k++){var ph=WV[k].kx*xw+WV[k].kz*zw;T[o+2*k]=Math.sin(ph);T[o+2*k+1]=Math.cos(ph)}
        var ca=xw*9+zw*3.3,cb=xw*5.7-zw*7.1;T[o+10]=Math.sin(ca);T[o+11]=Math.cos(ca);T[o+12]=Math.sin(cb);T[o+13]=Math.cos(cb);
        var vl=Math.sqrt(xw*xw+1+zw*zw);T[o+14]=-xw/vl;T[o+15]=1/vl;T[o+16]=-zw/vl;
        T[o+17]=vnz(xw*.9,zw*.9)*.65+vnz(xw*2.3,zw*2.3)*.35;
        T[o+18]=.6+.4*hs(Math.floor(xw*5),Math.floor(zw*5));
        T[o+19]=.1+.08*(d/dS0)}}
    // sand for every row below the horizon (the sea overwrites the part that is water): dunes, grain, pebbles, damp band, swash lines
    for(y=y0;y<PH;y++){d=y-hzp;var zq=f/d;
      for(x=0;x<PW;x++){var xq=(x-cx)/d,q=d-dS0,wet=Math.max(0,1-q/(GH*.2));i=y*PW+x;
        var dune=vnz(xq*.35,zq*.35)*.6+vnz(xq*1.1,zq*1.1)*.4,rip=Math.sin(zq*5+vnz(xq*.5,zq*.5)*6)*.5+.5,
            g1=vnz(xq*4,zq*4),g2=h2(Math.floor(xq*26),Math.floor(zq*26)),sg=h2(x,y)-.5,
            sv=.34+.2*(dune-.5)+.05*rip*(1-wet)+.1*(g1-.5)+.12*(g2-.5)+.16*sg+.05*(1-wet)*sstep(0,GH*.5,q),pb=h2(Math.floor(xq*10),Math.floor(zq*10));
        if(pb>.984)sv+=.22;else if(pb<.012)sv-=.17;
        var sw=Math.sin((q/GH)*44+Math.sin(x*.05)*1.4)*.5+.5;if(wet>0&&sw>.94)sv+=.1*wet;
        if(wet>.3){var wv=.16+.22*(1-wet)+.1*(g1-.5)+.1*sg;bg[i]=WETS[Math.min(3,dz(wv,x,y,3))];
          if(h2(x*5,y*3)>.985)glints.push(i,x,y,WETS[3],bg[i])}
        else{var sc_=SAND[Math.min(9,dz(sv,x,y,9))];bg[i]=sc_;if(h2(x*7,y*3)>.994)glints.push(i,x,y,SAND[9],sc_)}}}
    gN=glints.length;palmIdx=null}

  var PALMS=[                                        // x frac, height (frac of FH), lean, scale, body, rim, seed, fronds
    [.065,.2,.2,.95,"#05090f","#1b4552",11,12],
    [.865,.15,-.24,.85,"#070d18","#1f4d5c",3,11],
    [.94,.27,-.18,1.3,"#04070f","#2a6a78",7,13]];
  function bakePalms(t){                              // smooth palms on a scratch canvas, then ordered-dither coverage into solid pixels
    var gy=PH*.99,n=0,pi,x,y,j,a,th,R,G,B,k,i;
    if(!palmIdx){palmIdx=new Int32Array(PW*PH);palmCol=new Uint32Array(PW*PH)}
    for(pi=0;pi<PALMS.length;pi++){var p=PALMS[pi],bx=PW*p[0],h=FH*p[1],tx=bx+p[2]*h,L=h*.46*1.15+14*p[3];
      var rx0=Math.max(0,Math.floor(Math.min(bx,tx)-L)),rx1=Math.min(PW,Math.ceil(Math.max(bx,tx)+L)),ry0=Math.max(0,Math.floor(gy-h-L*.75)),ry1=Math.min(PH,Math.ceil(gy+4));
      if(rx1<=rx0||ry1<=ry0)continue;
      pctx.clearRect(rx0,ry0,rx1-rx0,ry1-ry0);
      pctx.save();pctx.beginPath();pctx.rect(rx0,ry0,rx1-rx0,ry1-ry0);pctx.clip();
      palm(pctx,bx,gy-(pi===1?PH*.012:0),h,p[2],t,p[3],p[4],p[5],p[6],p[7]);pctx.restore();
      var d=pctx.getImageData(rx0,ry0,rx1-rx0,ry1-ry0).data,w=rx1-rx0;
      for(i=0,j=3;j<d.length;i++,j+=4){a=d[j];if(!a)continue;x=rx0+i%w;y=ry0+((i/w)|0);th=BY[((y&3)<<2)|(x&3)];if(a/255<=th)continue;
        R=d[j-3];G=d[j-2];B=d[j-1];
        if(G<60&&th>.5){k=Math.max(0,1-(y/PH-.2)/.6);R+=k*7|0;G+=k*11|0;B+=k*17|0}
        palmIdx[n]=y*PW+x;palmCol[n]=(255<<24)|(B<<16)|(G<<8)|R;n++}}
    palmN=n}

  var cs=new Float32Array(10),Akx=new Float32Array(5),Akz=new Float32Array(5),A=new Float32Array(5);
  S.draw=function(t,still){
    if(!S.ready)return;if(still){if(!dirty)return;t=3}else if(last>=0&&t-last<.04)return;
    last=t;dirty=false;tick++;
    if(!img||img.width!==PW||img.height!==PH){img=ctx.createImageData(PW,PH);b32=new Uint32Array(img.data.buffer)}
    b32.set(bg);
    var x,y,r,i,o,k,ts=(t*5)|0,ts3=(t*3)|0,dS=dS0+GH*.03*Math.sin(t*.4);
    // per-frame wave constants: sin/cos of (w*t) so each pixel's baked phase is shifted by angle addition
    for(k=0;k<5;k++){var wt=WV[k].w*t;cs[2*k]=Math.sin(wt);cs[2*k+1]=Math.cos(wt);A[k]=WV[k].A;Akx[k]=WV[k].A*WV[k].kx;Akz[k]=WV[k].A*WV[k].kz}
    var s1=Math.sin(1.7*t),c1=Math.cos(1.7*t),s2=Math.sin(1.3*t),c2=Math.cos(1.3*t);
    for(x=0;x<PW;x++)ex[x]=Math.sin(x*.045+t*.8)*1.6+Math.sin(x*.13-t*.5)*.8;
    var s0w=cs[0],c0w=cs[1],s1w=cs[2],c1w=cs[3],s2w=cs[4],c2w=cs[5],s3w=cs[6],c3w=cs[7],s4w=cs[8],c4w=cs[9];
    for(r=0;r<NR;r++){
      y=y0+r;var d=y-hzp,far=rowFar[r],sl6=rowSl[r]*6,haze=rowHaze[r],dSr=dS+rowWob[r],keep=rowKeep[r],rb=y*PW,gA=.2*(.55+.45*far);
      o=r*PW*STR;
      for(x=0;x<PW;x++,o+=STR){
        var dd=d-(dSr+ex[x]);
        if(dd>=0){                                    // foam line where the swash meets the sand
          if(dd<1.6+hs(x,ts3)*1.4)b32[rb+x]=SEA[hs(x*3,y)>.3?7:6];
          continue}
        if(keep<1&&BY[((y&3)<<2)|(x&3)]>=keep)continue;   // far water is a dither of sea over void: the void itself becomes the horizon
        var sn,cn,hh=0,gx=0,gz=0;
        sn=T[o]*c0w-T[o+1]*s0w;cn=T[o+1]*c0w+T[o]*s0w;hh+=A[0]*sn;gx+=Akx[0]*cn;gz+=Akz[0]*cn;
        sn=T[o+2]*c1w-T[o+3]*s1w;cn=T[o+3]*c1w+T[o+2]*s1w;hh+=A[1]*sn;gx+=Akx[1]*cn;gz+=Akz[1]*cn;
        sn=T[o+4]*c2w-T[o+5]*s2w;cn=T[o+5]*c2w+T[o+4]*s2w;hh+=A[2]*sn;gx+=Akx[2]*cn;gz+=Akz[2]*cn;
        sn=T[o+6]*c3w-T[o+7]*s3w;cn=T[o+7]*c3w+T[o+6]*s3w;hh+=A[3]*sn;gx+=Akx[3]*cn;gz+=Akz[3]*cn;
        sn=T[o+8]*c4w-T[o+9]*s4w;cn=T[o+9]*c4w+T[o+8]*s4w;hh+=A[4]*sn;gx+=Akx[4]*cn;gz+=Akz[4]*cn;
        var nx=-gx*sl6,nz=-gz*sl6,inv=1/Math.sqrt(nx*nx+1+nz*nz);nx*=inv;nz*=inv;var ny=inv;
        var vx=T[o+14],vy=T[o+15],vz=T[o+16],nv=nx*vx+ny*vy+nz*vz;if(nv<0)nv=0;
        var qn=1-nv,q2=qn*qn,Fr=.03+.97*q2*q2*qn;
        var ry=2*nv*ny-vy,rxx=2*nv*nx-vx,rzz=2*nv*nz-vz,u=(ry>0?ry:0)*224,sky=.5*EXP[u>255?255:u|0]+.04;
        var den=(ry<0?-ry:ry)+.2,key=h2(Math.floor(rxx/den*9),Math.floor(rzz/den*9)),gl=0;
        if(key>.972)gl=.5+.5*Math.sin(t*2+key*90);
        var fo=(hh-.085)*12;fo=fo>0?fo*T[o+18]*far:0;
        if(fo>.6){b32[rb+x]=SEA[7];continue}
        var sa=T[o+10]*c1-T[o+11]*s1,sb=T[o+12]*c2+T[o+13]*s2,cap=sa*sb*.5+.5;
        var v=T[o+19]-.03+haze+Fr*sky*.5+gl*.42*far+fo*.42+(T[o+17]-.5)*.1+cap*.045*far+(h2(x+ts*7,y)-.5)*gA;
        if(v>.86)v=.86;var s=v<0?0:v*7,fl=s|0;b32[rb+x]=SEA[fl+((s-fl)>BY[((y&3)<<2)|(x&3)]?1:0)]}}
    // twinkling flecks on the dry sand / damp band (baked positions, only those that are land this frame)
    for(i=0;i<gN;i+=5){var gxp=glints[i+1],gyp=glints[i+2];if(gyp-hzp<dS+ex[gxp]+5)continue;
      b32[glints[i]]=Math.sin(t*2.2+gxp)>.55?glints[i+3]:glints[i+4]}
    if(!palmIdx||tick%4===1)bakePalms(t);                 // palms sway slowly, so re-bake them every few frames
    for(i=0;i<palmN;i++)b32[palmIdx[i]]=palmCol[i];
    ctx.putImageData(img,0,0)};

  window.Shore=S;
})();
