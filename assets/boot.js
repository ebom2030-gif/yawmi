/* يومي — سكربت الإقلاع (v279): كان مضمّناً داخل index.html، ونُقل إلى ملف مستقل ليعمل البرنامج بسياسة أمان (CSP) تمنع السكربتات المضمّنة. يُحمَّل قبل كل شيء في <head>. */
window.__yerr=[];window.onerror=function(m,s,l,c){try{window.__yerr.push({m:String(m),s:String(s||"").split("/").pop()+":"+l+":"+c})}catch(e){}if(/[?&]debug/.test(location.search)){var d=document.createElement("pre");d.style.cssText="color:#b00;white-space:pre-wrap;direction:ltr;font-size:12px";d.textContent="ERR: "+m+" @"+l+":"+c;(document.body||document.documentElement).prepend(d);}};
try{var yr=document.documentElement,yb=JSON.parse(localStorage.getItem("yw198Boot")||"null");if(yb&&yb.bg)yr.style.setProperty("--y198-bg",yb.bg);if(yb&&yb.fg)yr.style.setProperty("--y198-fg",yb.fg);yr.classList.add("y198-boot");setTimeout(function(){yr.classList.remove("y198-boot");var s=document.getElementById("y198Splash");s&&s.remove()},15000)}catch(e){}
try{var yd=document.documentElement,yt=localStorage.getItem("yw_theme");if(yt)yd.dataset.theme=yt;["acc","fs","dens","rad"].forEach(function(k){var v=localStorage.getItem("yw_"+k);if(v)yd.dataset[k]=v});var yi=localStorage.getItem("yw_ico");if(yi)yd.dataset.ico=yi}catch(e){}
try{var k=localStorage.getItem("yw_skin");if(k&&k!=="night")document.documentElement.dataset.skin=k;}catch(e){}
/* بدائل المعالجات المضمّنة (onclick / onerror) — تُطبَّق بالسمات data-* */
window.addEventListener("click",function(e){var t=e.target;if(!t||!t.closest)return;
 if(t.closest("[data-ystop]")){e.stopPropagation();return}                       /* زر واتساب داخل صف قابل للضغط: يفتح الرابط دون فتح الصف */
 var c=t.closest("[data-yclose]");if(c&&c.parentNode){c.parentNode.hidden=true}},true); /* زر الإغلاق في شريط الإشعارات */
window.addEventListener("error",function(e){var t=e.target;if(t&&t.tagName==="IMG"&&t.dataset&&t.dataset.yfb&&t.getAttribute("src")!==t.dataset.yfb){t.src=t.dataset.yfb}},true); /* صورة بديلة عند تعذّر تحميل الصورة الكبيرة */
