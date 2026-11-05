// A diagnostics-only dyld interposer for our own native A/B benchmark.
// Trace large allocations with exact address lifetimes and executable stack
// offsets. Aggregate small allocations in malloc_zone_statistics. Instruments
// and this dylib are never loaded by the product or used for performance runs.
#include <execinfo.h>
#include <unwind.h>
#include <fcntl.h>
#include <inttypes.h>
#include <mach/mach.h>
#include <mach/mach_vm.h>
#include <mach-o/dyld.h>
#include <malloc/malloc.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <time.h>
#include <unistd.h>

static int output = -1;
static size_t threshold = 16384;
static _Atomic int tracing;
static _Thread_local int inside;
static uintptr_t image, image_end;
static pthread_t sampler;
static pthread_mutex_t stack_lock = PTHREAD_MUTEX_INITIALIZER;
enum { DEPTH = 19, SLOTS = 8192 };
static struct { uint64_t hash; uintptr_t pc[DEPTH]; } stacks[SLOTS];
static unsigned overflows;
static unsigned tile_stack,frame_stack;
static _Atomic uintptr_t tile_pointer,frame_pointer;
static int relief_kind;
static unsigned tiles_finished;
static _Atomic int tail;
static uint64_t sample(char kind);
static void regions(uint64_t stamp);
static uint64_t now(void) { return clock_gettime_nsec_np(CLOCK_UPTIME_RAW); }
static void line(const char *fmt, ...) {
    char buf[1024]; va_list a; va_start(a,fmt);
    int n=vsnprintf(buf,sizeof buf,fmt,a); va_end(a);
    if(n>0 && (size_t)n<sizeof buf) { ssize_t written=write(output,buf,n); (void)written; }
}
struct walk { uintptr_t pc[DEPTH]; unsigned used; };
static _Unwind_Reason_Code frame(struct _Unwind_Context *ctx,void *arg) {
    struct walk *w=arg;uintptr_t p=(uintptr_t)_Unwind_GetIP(ctx);
    if(p>=image && p<image_end)w->pc[w->used++]=p-image;
    return w->used==DEPTH ? _URC_END_OF_STACK : _URC_NO_REASON;
}
static unsigned stack_id(void) {
    struct walk w={0};_Unwind_Backtrace(frame,&w);
    uintptr_t *pc=w.pc; unsigned used=w.used;
    uint64_t h=1469598103934665603ull;
    for(unsigned i=0;i<used;i++)h=(h^pc[i])*1099511628211ull;
    h|=1;
    pthread_mutex_lock(&stack_lock);
    for(unsigned j=0;j<SLOTS;j++){
        unsigned k=(h+j)&(SLOTS-1);
        if(stacks[k].hash==h && !memcmp(stacks[k].pc,pc,sizeof w.pc)){
            pthread_mutex_unlock(&stack_lock);return k+1;
        }
        if(!stacks[k].hash){
            stacks[k].hash=h;memcpy(stacks[k].pc,pc,sizeof w.pc);
            char b[512];int n=snprintf(b,sizeof b,"K %u",k+1);
            for(unsigned q=0;q<used;q++)n+=snprintf(b+n,sizeof b-(size_t)n," %lx",(unsigned long)pc[q]);
            line("%s\n",b);pthread_mutex_unlock(&stack_lock);return k+1;
        }
    }
    overflows++;pthread_mutex_unlock(&stack_lock);return 0;
}
static void allocation(void *ptr,size_t requested){
    if(!ptr || requested<threshold || inside || !atomic_load(&tracing))return;
    inside=1; unsigned k=stack_id();
    if(k==tile_stack && requested==4194304)tile_pointer=(uintptr_t)ptr;
    if(k==frame_stack && requested==16777216)frame_pointer=(uintptr_t)ptr;
    line("A %"PRIu64" %lx %zu %zu %u\n",now(),(unsigned long)ptr,requested,malloc_size(ptr),k);
    inside=0;
}
static void *tr_malloc(size_t n){void *p=malloc(n);allocation(p,n);return p;}
static void *tr_calloc(size_t n,size_t s){void *p=calloc(n,s);if(p)allocation(p,n*s);return p;}
static int tr_align(void **p,size_t a,size_t n){int e=posix_memalign(p,a,n);if(!e)allocation(*p,n);return e;}
static void tr_free(void *p){
    int kind=0;
    if(p && !inside && atomic_load(&tracing)){
        size_t n=malloc_size(p);
        if(atomic_load(&tail)){inside=1;unsigned st=stack_id();line("Y %"PRIu64" %lx %zu %u\n",now(),(unsigned long)p,n,st);inside=0;}
        if(n>=threshold){inside=1;line("F %"PRIu64" %lx %zu\n",now(),(unsigned long)p,n);inside=0;}
        if((uintptr_t)p==tile_pointer){kind='T';tile_pointer=0;}
        if((uintptr_t)p==frame_pointer){kind='G';frame_pointer=0;}
    }
    free(p);
    if(kind){
        inside=1;sample((char)kind);regions(now());
        if(kind=='T' && ++tiles_finished%4==0)atomic_store(&tail,1);
        if(kind=='G')atomic_store(&tail,0);
        if(relief_kind==kind){
            size_t released=malloc_zone_pressure_relief(NULL,0);
            line("L %"PRIu64" %d %zu\n",now(),kind,released);
            sample('P');regions(now());
        }
        inside=0;
    }
}
static void *tr_realloc(void *p,size_t n){
    int active=!inside && atomic_load(&tracing);
    size_t old=active && p ? malloc_size(p):0;
    uintptr_t addr=(uintptr_t)p;
    void *next=realloc(p,n);
    if(active && (next || !n)){
        if(old>=threshold){inside=1;line("F %"PRIu64" %lx %zu\n",now(),(unsigned long)addr,old);inside=0;}
        allocation(next,n);
    }
    return next;
}
#define INTERPOSE(r,f) __attribute__((used)) static struct { const void *rfn,*orig; } pair_##f __attribute__((section("__DATA,__interpose")))={(void*)r,(void*)f}
INTERPOSE(tr_malloc,malloc); INTERPOSE(tr_calloc,calloc); INTERPOSE(tr_free,free);
INTERPOSE(tr_realloc,realloc); INTERPOSE(tr_align,posix_memalign);

static void regions(uint64_t stamp){
    mach_vm_address_t a=0; natural_t depth=0;
    for(;;){
        mach_vm_size_t size=0;vm_region_submap_info_data_64_t v={0};
        mach_msg_type_number_t n=VM_REGION_SUBMAP_INFO_COUNT_64;
        if(mach_vm_region_recurse(mach_task_self(),&a,&size,&depth,(vm_region_recurse_info_t)&v,&n)!=KERN_SUCCESS)break;
        if(v.is_submap){depth++;continue;}
        if(v.user_tag<=13 && v.user_tag!=0 && v.pages_resident)
            line("R %"PRIu64" %llx %llu %u %u %u %u\n",stamp,a,size,v.user_tag,v.pages_resident,v.pages_reusable,v.pages_swapped_out);
        // Resolve actual resident pages in malloc-large regions; coalesced
        // regions can contain both live objects and freed allocations.
        if((v.user_tag==3 || v.user_tag==4 || v.user_tag==8 || v.user_tag==9) && v.pages_resident){
            char state[2048];
            for(uint64_t offset=0; offset<size;){
                size_t bytes=(size_t)(size-offset), cap=sizeof state*vm_kernel_page_size;
                if(bytes>cap)bytes=cap;
                if(!mincore((void*)(uintptr_t)(a+offset),bytes,state)){
                    size_t len=bytes/vm_kernel_page_size, start=0;
                    for(size_t i=0;i<=len;i++){
                        if(i<len && (state[i]&MINCORE_INCORE))continue;
                        if(i>start)line("V %"PRIu64" %llx %zu\n",stamp,a+offset+start*vm_kernel_page_size,i-start);
                        start=i+1;
                    }
                }
                offset+=bytes;
            }
        }
        if(!size || UINT64_MAX-a<size)break;
        a+=size;
    }
}
static uint64_t sample(char kind){
    task_vm_info_data_t v={0};mach_msg_type_number_t n=TASK_VM_INFO_COUNT;
    malloc_statistics_t s={0};malloc_zone_statistics(NULL,&s);
    if(task_info(mach_task_self(),TASK_VM_INFO,(task_info_t)&v,&n)!=KERN_SUCCESS)return 0;
    line("%c %"PRIu64" %llu %llu %llu %llu %llu %zu %zu %u\n",kind,now(),
         v.resident_size,v.phys_footprint,v.internal,v.compressed,v.reusable,s.size_in_use,s.size_allocated,s.blocks_in_use);
    return v.resident_size;
}
static void *watch(void *unused){
    (void)unused;inside=1; uint64_t peak=0;unsigned i=0;
    while(atomic_load(&tracing)){
        uint64_t rss=sample('S');
        if(rss>peak+2097152 || (++i%24)==0){regions(now());if(rss>peak)peak=rss;}
        usleep(5000);
    }
    return NULL;
}
__attribute__((constructor)) static void start(void){
    const char *path=getenv("RETENTION_TRACE"),*exe=getenv("RETENTION_EXE");
    if(!path || !exe || strcmp(getprogname(),exe))return;
    output=open(path,O_CREAT|O_EXCL|O_WRONLY|O_CLOEXEC|O_APPEND,0600); if(output<0)return;
    const char *minimum=getenv("RETENTION_MIN"); if(minimum)threshold=strtoull(minimum,NULL,10);
    const char *ts=getenv("RETENTION_TILE_STACK"),*fs=getenv("RETENTION_FRAME_STACK"),*relief=getenv("RETENTION_RELIEF");
    if(ts)tile_stack=(unsigned)atoi(ts);if(fs)frame_stack=(unsigned)atoi(fs);
    if(relief)relief_kind=*relief;
    const struct mach_header_64 *hdr=NULL;
    for(uint32_t i=0;i<_dyld_image_count();i++){
        const struct mach_header *h=_dyld_get_image_header(i);
        if(h->filetype==MH_EXECUTE){hdr=(const void*)h;break;}
    }
    if(!hdr){close(output);output=-1;return;}
    image=(uintptr_t)hdr;
    const struct load_command *lc=(void*)(hdr+1);
    for(unsigned i=0;i<hdr->ncmds;i++){
        if(lc->cmd==LC_SEGMENT_64){const struct segment_command_64 *s=(void*)lc;
            if(!strcmp(s->segname,"__TEXT"))image_end=image+s->vmsize;}
        lc=(void*)((const char*)lc+lc->cmdsize);
    }
    void *warm[4];backtrace(warm,4); line("H %zu %u %lx\n",threshold,vm_kernel_page_size,(unsigned long)image);
    atomic_store(&tracing,1);pthread_create(&sampler,NULL,watch,NULL);
}
__attribute__((destructor)) static void finish(void){
    if(output<0)return;
    atomic_store(&tracing,0);pthread_join(sampler,NULL);inside=1;sample('E');regions(now());
    line("X %u\n",overflows);close(output);
}
