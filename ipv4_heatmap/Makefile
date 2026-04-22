INCS=-I/usr/local/include -I/opt/homebrew/include
LIBS=-L/usr/local/lib -L/opt/homebrew/lib -lgd -lm
CFLAGS=-g -Wall ${INCS}
LDFLAGS=-g
OBJS=\
	ipv4-heatmap.o \
	xy_from_ip.o \
	hilbert.o \
	morton.o \
	annotate.o \
	shade.o \
	legend.o \
	bbox.o \
	text.o \
	cidr.o

IPV6_OBJS=\
	ipv6-heatmap.o \
	xy_from_ip.o \
	hilbert.o \
	morton.o \
	annotate.o \
	shade.o \
	legend.o \
	bbox.o \
	text.o \
	cidr.o

IPV6_2000_OBJS=\
	ipv6-heatmap-2000.o \
	xy_from_ip.o \
	hilbert.o \
	morton.o \
	annotate.o \
	shade.o \
	legend.o \
	bbox.o \
	text.o \
	cidr.o

all: ipv4-heatmap ipv6-heatmap ipv6-heatmap-2000

ipv4-heatmap: ${OBJS}
	${CC} ${LDFLAGS} -o $@ ${OBJS} ${LIBS}

ipv6-heatmap: ${IPV6_OBJS}
	${CC} ${LDFLAGS} -o $@ ${IPV6_OBJS} ${LIBS}

ipv6-heatmap-2000: ${IPV6_2000_OBJS}
	${CC} ${LDFLAGS} -o $@ ${IPV6_2000_OBJS} ${LIBS}

clean:
	rm -f ${OBJS} ${IPV6_OBJS} ${IPV6_2000_OBJS}
	rm -f ipv4-heatmap ipv6-heatmap ipv6-heatmap-2000

install: ipv4-heatmap
	install -C -m 755 ipv4-heatmap /usr/local/bin
	install -C -m 755 ipv4-heatmap.1 /usr/local/man/man1
