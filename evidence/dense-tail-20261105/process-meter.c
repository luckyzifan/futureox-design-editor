// Read-only macOS process accounting. CPU values from the Darwin resource
// usage API are calibrated against getrusage(RUSAGE_SELF) by --calibrate.
#include <libproc.h>
#include <sys/resource.h>
#include <sys/time.h>
#include <mach/mach_time.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <unistd.h>
static uint64_t nanos(uint64_t ticks){
 static mach_timebase_info_data_t tb; if(!tb.denom)mach_timebase_info(&tb);
 return (uint64_t)((__uint128_t)ticks*tb.numer/tb.denom);
}
static void read_pid(int p){
 struct rusage_info_v4 r;
 if(proc_pid_rusage(p,RUSAGE_INFO_V4,(rusage_info_t*)&r)){puts("null");return;}
 printf("[%llu,%llu,%llu,%llu,%llu,%llu,%llu]\n",
  (unsigned long long)nanos(r.ri_user_time),(unsigned long long)nanos(r.ri_system_time),(unsigned long long)r.ri_pageins,
  (unsigned long long)r.ri_phys_footprint,(unsigned long long)r.ri_resident_size,
  (unsigned long long)r.ri_diskio_bytesread,(unsigned long long)r.ri_diskio_byteswritten);
}
int main(int argc,char**argv){
 setvbuf(stdout,NULL,_IOLBF,0);
 if(argc>1&&!strcmp(argv[1],"--calibrate")){
  struct rusage a,b;struct rusage_info_v4 x,y;
  getrusage(RUSAGE_SELF,&a);proc_pid_rusage(getpid(),RUSAGE_INFO_V4,(rusage_info_t*)&x);
  for(volatile unsigned i=0;i<50000000;i++){}
  getrusage(RUSAGE_SELF,&b);proc_pid_rusage(getpid(),RUSAGE_INFO_V4,(rusage_info_t*)&y);
  printf("%lld us self / %llu us from resource ticks\n",(long long)(b.ru_utime.tv_sec-a.ru_utime.tv_sec)*1000000+b.ru_utime.tv_usec-a.ru_utime.tv_usec,(unsigned long long)(nanos(y.ri_user_time-x.ri_user_time)/1000));
  return 0;
 }
 int pid;while(scanf("%d",&pid)==1)read_pid(pid);return 0;
}
