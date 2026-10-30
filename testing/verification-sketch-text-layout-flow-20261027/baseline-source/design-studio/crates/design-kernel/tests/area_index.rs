use futureox_design_kernel::{area_program::AreaProgram, math::{Rect, Transform}, path::Path};

#[test]
fn sorted_scanlines_preserve_candidate_order_and_reduce_long_row_reads() {
    for count in [1, 16, 128, 512] {
        let mut contours=Vec::new();
        for i in 0..count {
            contours.extend(Path::rectangle(384. / count as f64, 3.875, [0.;4], 0.)
                .flatten(Transform([1.,0.,0.,1.,-2.125+i as f64*768./count as f64,-0.375]),1./64.).unwrap());
        }
        for samples in [false,true] {
            let program=if samples {AreaProgram::compile_samples(&contours,Rect::new(-4,-2,780,8),false)}
                else {AreaProgram::compile(&contours,Rect::new(-4,-2,780,8),false)}.unwrap();
            if count==1 {continue;} // The one-rectangle program has a separate exact shortcut.
            let rows=program.rect.h as usize*if samples {4}else{8};
            let mut old_reads=0usize;let mut new_reads=0usize;
            for row in 0..rows {
                let first=program.data[4+row*4] as usize*4;
                let n=program.data[5+row*4] as usize;
                let ranges:Vec<_>=(0..n).map(|i|(program.data[first+i*12] as i32,program.data[first+i*12+1] as i32)).collect();
                assert!(ranges.windows(2).all(|r|r[0].0<=r[1].0&&r[0].1<=r[1].1));
                for x in -1..program.rect.w as i32+1 {
                    let expected:Vec<_>=ranges.iter().enumerate().filter(|(_,r)|r.0<=x&&r.1>=x).map(|(i,_)|i).collect();
                    old_reads+=n;
                    let (mut lo,mut hi)=(0,n);
                    if n>=16 {while lo<hi {let mid=lo+(hi-lo)/2;new_reads+=1;
                        if ranges[mid].1<x {lo=mid+1;} else {hi=mid;}}}
                    let mut actual=Vec::new();
                    for (i,r) in ranges.iter().enumerate().skip(lo) {new_reads+=1;
                        if x<r.0 {break;} if x<=r.1 {actual.push(i);}}
                    assert_eq!(actual,expected);
                }
            }
            println!("intervals={count} samples={samples} full_reads={old_reads} indexed_reads={new_reads}");
            assert!(new_reads*2<old_reads);
        }
    }
}
