#!/usr/bin/env python3
"""Render current native screen marks on synthetic backgrounds (macOS only).

Run `cargo test --manifest-path src-tauri/Cargo.toml --lib screen_annotation`
first to prepare the local Objective-C dependency libraries. This script uses
hidden native views only: no desktop capture, permission prompt, or activation.
"""
import argparse
import os
from pathlib import Path
import subprocess
import sys
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--output-dir", type=Path)
args = parser.parse_args()
if sys.platform != "darwin":
    raise SystemExit("Native AppKit previews require macOS.")
project = Path(__file__).resolve().parents[1]
output_dir = (args.output_dir or project / "docs/assets").resolve()
output_dir.mkdir(parents=True, exist_ok=True)
source = (project / "src-tauri/src/screen_annotation/macos.rs").read_text()

prefix='''#![allow(dead_code)]
mod screen_annotation {
    #[derive(Debug,Clone,Copy,PartialEq)]
    pub(super) struct DisplayGeometry {pub source_id:u32,pub x:f64,pub y:f64,pub width:f64,pub height:f64,pub pixel_width:usize,pub pixel_height:usize,pub main_height:f64}
    #[derive(Debug,Clone,Copy)]
    pub(super) enum AnnotationTarget {Arrow{x:f64,y:f64},Rect{x:f64,y:f64,width:f64,height:f64},Ellipse{x:f64,y:f64,width:f64,height:f64}}
    pub(super) mod macos {
'''
suffix=r'''
use objc2::AnyThread;
use objc2_app_kit::NSGradient;
#[derive(Debug)] struct PreviewStyle {mode:u8}
define_class!(
    #[unsafe(super(NSView))]
    #[name = "YorishiroAnnotationPreviewCanvas"]
    #[ivars = PreviewStyle]
    struct PreviewCanvas;
    impl PreviewCanvas {
        #[unsafe(method(isFlipped))] fn is_flipped(&self)->bool{true}
        #[unsafe(method(drawRect:))] fn draw_rect(&self,_dirty:NSRect){
            let dark=self.ivars().mode!=1;
            let mixed=self.ivars().mode==2;
            color(if dark{0x141619}else{0xf5f5f1},1.0).setFill();
            NSBezierPath::fillRect(self.bounds());
            for x in [32.0,392.0,752.0] {
                let panel=NSBezierPath::bezierPathWithRoundedRect_xRadius_yRadius(rect(x,112.0,336.0,326.0),6.0,6.0);
                color(if dark{0x1c2023}else{0xffffff},1.0).setFill();panel.fill();
                color(if dark{0x303633}else{0xdde1da},1.0).setStroke();panel.setLineWidth(0.75);panel.stroke();
                if mixed {
                    // A deterministic studio-like mix of shadows, highlights,
                    // texture, and object edges; never a photograph of a screen.
                    let gradient=NSGradient::initWithStartingColor_endingColor(
                        NSGradient::alloc(),&color(0x202c27,1.0),&color(0xe2d8c1,1.0)).unwrap();
                    gradient.drawInRect_angle(rect(x+1.0,113.0,334.0,324.0),-35.0);
                    for row in 0..20 {for column in 0..21 {
                        let wave=((row as f64*1.71+column as f64*2.13).sin()+1.0)/2.0;
                        color(if wave>0.5{0xf7eed8}else{0x17372e},0.10+wave*0.13).setFill();
                        NSBezierPath::bezierPathWithOvalInRect(rect(x+2.0+column as f64*15.5,116.0+row as f64*15.8,9.0+wave*5.0,8.0+wave*5.0)).fill();
                    }}
                    let object=NSBezierPath::bezierPathWithOvalInRect(rect(x+86.0,214.0,164.0,188.0));
                    color(0xf2ece0,0.72).setFill();object.fill();
                    let shade=NSBezierPath::bezierPathWithOvalInRect(rect(x+132.0,254.0,87.0,115.0));
                    color(0x3c4a3e,0.73).setFill();shade.fill();
                }
                let grid=NSBezierPath::bezierPath();
                for index in 0..10 {
                    let gx=x+20.0+index as f64*32.0;
                    grid.moveToPoint(NSPoint::new(gx,176.0));grid.lineToPoint(NSPoint::new(gx,416.0));
                }
                for index in 0..8 {
                    let gy=176.0+index as f64*32.0;
                    grid.moveToPoint(NSPoint::new(x+16.0,gy));grid.lineToPoint(NSPoint::new(x+320.0,gy));
                }
                color(if dark{0x353c37}else{0xd1d8cf},0.35).setStroke();grid.setLineWidth(0.5);grid.stroke();
            }
            let mesh=NSBezierPath::bezierPath();
            for (a,b) in [((80.0,344.0),(126.0,260.0)),((126.0,260.0),(204.0,336.0)),((204.0,336.0),(80.0,344.0)),((80.0,344.0),(136.0,382.0)),((204.0,336.0),(136.0,382.0)),((126.0,260.0),(136.0,382.0))] {
                mesh.moveToPoint(NSPoint::new(a.0,a.1));mesh.lineToPoint(NSPoint::new(b.0,b.1));
            }
            color(if dark{0x67756a}else{0xabb5ac},0.65).setStroke();mesh.setLineWidth(1.0);mesh.stroke();
            for y in [254.0,282.0,310.0,338.0] {
                color(if dark{0x526057}else{0xc5cdc4},0.4).setFill();NSBezierPath::fillRect(rect(448.0,y,150.0,4.0));
                NSBezierPath::fillRect(rect(630.0,y,22.0,4.0));
            }
            let oval=NSBezierPath::bezierPathWithOvalInRect(rect(842.0,250.0,130.0,98.0));
            color(if dark{0x415047}else{0xdde5db},0.6).setFill();oval.fill();
            let seam=NSBezierPath::bezierPath();
            seam.moveToPoint(NSPoint::new(906.0,250.0));seam.lineToPoint(NSPoint::new(906.0,348.0));
            seam.moveToPoint(NSPoint::new(842.0,298.0));seam.lineToPoint(NSPoint::new(972.0,298.0));
            color(if dark{0x6b7b6f}else{0xa1b09f},0.5).setStroke();seam.setLineWidth(0.75);seam.stroke();
        }
    }
);
fn caption(parent:&NSView,mtm:MainThreadMarker,text:&str,x:f64,y:f64,font:f64,ink:u32){
    let label=NSTextField::labelWithString(&NSString::from_str(text),mtm);
    label.setFont(Some(&NSFont::systemFontOfSize(font)));label.setTextColor(Some(&color(ink,1.0)));
    label.sizeToFit();let size=label.frame().size;label.setFrame(rect(x,y,size.width,size.height));parent.addSubview(&label);
}
pub(crate) fn render_preview(){
    use objc2_app_kit::{NSApplication,NSApplicationActivationPolicy,NSBitmapImageFileType};
    use objc2_foundation::NSDictionary;
    let mtm=MainThreadMarker::new().unwrap();
    let app=NSApplication::sharedApplication(mtm);app.setActivationPolicy(NSApplicationActivationPolicy::Accessory);
    let font_start=std::time::Instant::now();
    let font=annotation_font(mtm);
    assert_eq!(font.fontName().to_string(),"KleeOne-SemiBold");
    let covered=font.coveredCharacterSet();
    for character in "この稜線設定のまとまり丸みここを調整範囲".encode_utf16() {assert!(covered.characterIsMember(character));}
    println!("Native label font={} size={} first_load_us={} Japanese_glyphs_verified=true",font.fontName(),font.pointSize(),font_start.elapsed().as_micros());
    for (mode,name) in [(0,"dark"),(1,"light"),(2,"mixed")] {
        let dark=mode!=1;
        let size=NSSize::new(1120.0,504.0);
        let allocated=PreviewCanvas::alloc(mtm).set_ivars(PreviewStyle{mode});
        let canvas:Retained<PreviewCanvas>=unsafe{msg_send![super(allocated),initWithFrame:NSRect::new(NSPoint::ZERO,size)]};
        let fg=if dark{FOREGROUND}else{0x28312b};
        let dim=if dark{0x89968b}else{0x758173};
        caption(&canvas,mtm,"Yorishiro / 画面の注記",32.0,24.0,21.0,fg);
        caption(&canvas,mtm,match mode{0=>"Dark workspace · native handwriting",1=>"Light workspace · native handwriting",_=>"Mixed synthetic scene · native handwriting"},32.0,62.0,12.0,dim);
        for (x,title) in [(52.0,"矢印"),(412.0,"囲み"),(772.0,"楕円")] {caption(&canvas,mtm,title,x,136.0,12.0,dim);}
        for (target,label) in [
            (AnnotationTarget::Arrow{x:126.0,y:320.0},"この稜線"),
            (AnnotationTarget::Rect{x:424.0,y:228.0,width:252.0,height:142.0},"設定のまとまり"),
            (AnnotationTarget::Ellipse{x:792.0,y:228.0,width:232.0,height:142.0},"この丸み"),
        ] {canvas.addSubview(&create_view(mtm,target,size,Some(label)));}
        caption(&canvas,mtm,"同じ注釈を明暗の背景で確認。背景の図形はプレビュー用の合成図です。",32.0,466.0,11.0,dim);
        let panel=create_panel(mtm,NSRect::new(NSPoint::ZERO,size));panel.setContentView(Some(&canvas));
        let bitmap=canvas.bitmapImageRepForCachingDisplayInRect(NSRect::new(NSPoint::ZERO,size)).unwrap();
        canvas.cacheDisplayInRect_toBitmapImageRep(NSRect::new(NSPoint::ZERO,size),&bitmap);
        let png=unsafe{bitmap.representationUsingType_properties(NSBitmapImageFileType::PNG,&NSDictionary::new())}.unwrap();
        let output=std::env::args().nth(1).expect("output directory");
        let path=std::path::Path::new(&output).join(format!("screen-pointers-{}.png",name));
        std::fs::write(&path,png.to_vec()).unwrap();
        println!("Rendered own native view on synthetic background: {}",path.display());
        panel.setContentView(None);panel.close();
    }
}
    }
}
fn main(){screen_annotation::macos::render_preview();}
'''
dependencies = project / "src-tauri/target/debug/deps"
externs = []
for crate in ["objc2", "objc2_app_kit", "objc2_foundation"]:
    libraries = list(dependencies.glob(f"lib{crate}-*.rlib"))
    if not libraries:
        raise SystemExit(f"Build Rust dependencies first; missing {crate} in {dependencies}")
    library = max(libraries, key=lambda path: path.stat().st_mtime_ns)
    externs += ["--extern", f"{crate}={library}"]
with tempfile.TemporaryDirectory(prefix="yorishiro-pointer-preview-") as temporary:
    temporary = Path(temporary)
    rust_source = temporary / "preview.rs"
    binary = temporary / "preview"
    rust_source.write_text(prefix + source + suffix)
    subprocess.run(["rustc", "--edition=2021", str(rust_source), "-o", str(binary),
                    "-L", f"dependency={dependencies}", *externs], check=True,
                   env={**os.environ, "CARGO_MANIFEST_DIR": str(project / "src-tauri")})
    subprocess.run([str(binary), str(output_dir)], check=True)
