/* BeatLab — piccole utilità DOM condivise */
export const $ = id => document.getElementById(id);

export function toast(msg, label, fn){
  const t=$('toast'), b=$('toastbtn');
  if(!t) return;
  $('toasttx').textContent=msg;
  if(label){ b.style.display=''; b.textContent=label;
    b.onclick=()=>{ fn&&fn(); t.classList.remove('show'); }; }
  else b.style.display='none';
  t.classList.add('show');
  clearTimeout(toast._t); toast._t=setTimeout(()=>t.classList.remove('show'), label?9000:2600);
}
